/**
 * History Trimmer
 * Trims the messages array to a configurable sliding window.
 * Keeps the first keepFirstN messages (initial context exchange) plus
 * the last (maxMessages - keepFirstN) messages.
 *
 * IMPORTANT: Never orphan tool_use / tool_result pairs. If trimming would
 * remove an assistant message containing tool_use blocks but keep the
 * subsequent user message with matching tool_result blocks (or vice versa),
 * extend the kept window to include both. This prevents Azure/OpenAI from
 * rejecting the request with "No tool call found for function call output".
 */

class HistoryTrimmer {
  /**
   * @param {Array} messages
   * @param {{ maxMessages?: number, keepFirstN?: number }} options
   * @returns {{ messages: Array, trimmed: number, originalCount: number }}
   */
  trim(messages, options = {}) {
    const maxMessages = options.maxMessages ?? 40;
    const keepFirstN  = Math.min(options.keepFirstN ?? 2, maxMessages);

    if (!Array.isArray(messages)) return { messages: [], trimmed: 0, originalCount: 0 };
    const originalCount = messages.length;
    if (originalCount <= maxMessages) return { messages, trimmed: 0, originalCount };

    const first = messages.slice(0, keepFirstN);
    const rest  = messages.slice(keepFirstN);
    const keepLast = Math.max(0, maxMessages - keepFirstN);

    if (rest.length <= keepLast) {
      return { messages, trimmed: 0, originalCount };
    }

    // Candidate cut index within `messages`: we want to keep all messages before
    // keepFirstN plus messages[cutIdx .. end]. Work against the full array so a
    // tool_result just after the cut can still see a tool_use before keepFirstN.
    let cutIdx = originalCount - keepLast;

    // Walk the cut boundary backwards to avoid orphaning tool pairs. If safe
    // trimming cannot fit inside the configured window, this intentionally keeps
    // extra messages rather than sending an invalid tool transcript upstream.
    cutIdx = this._adjustCutForToolPairs(messages, cutIdx, keepFirstN);

    const keep = new Set();
    for (let i = 0; i < keepFirstN; i++) keep.add(i);
    for (let i = cutIdx; i < originalCount; i++) keep.add(i);

    const keptMessages = messages.filter((_, i) => keep.has(i));
    const trimmed = originalCount - keptMessages.length;

    return { messages: keptMessages, trimmed, originalCount };
  }

  validate(messages) {
    const seenToolUses = new Set();
    const orphanToolResults = [];
    if (!Array.isArray(messages)) return { ok: true, orphanToolResults };
    for (let i = 0; i < messages.length; i++) {
      for (const block of this._contentBlocks(messages[i])) {
        if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id) seenToolUses.add(block.id);
        if (block.type === 'tool_result' && (!block.tool_use_id || !seenToolUses.has(block.tool_use_id))) {
          orphanToolResults.push({ index: i, id: block.tool_use_id || '(missing)' });
        }
      }
    }
    return { ok: orphanToolResults.length === 0, orphanToolResults };
  }

  /**
   * Adjust the cut index so the retained transcript never contains tool_result
   * blocks without their matching earlier tool_use blocks. Tool IDs are generated
   * by the model/provider and can be non-adjacent once text turns are mixed in, so
   * this resolves by ID rather than only checking the previous message.
   */
  _adjustCutForToolPairs(messages, cutIdx, keepFirstN = 0) {
    const mustKeep = new Set();
    for (let i = 0; i < keepFirstN; i++) mustKeep.add(i);
    for (let i = cutIdx; i < messages.length; i++) mustKeep.add(i);

    let changed = true;
    while (changed) {
      changed = false;
      const keptToolResultIds = new Set();
      const keptToolUseIds = new Set();

      for (const i of mustKeep) {
        const msg = messages[i];
        for (const block of this._contentBlocks(msg)) {
          if (block.type === 'tool_result' && block.tool_use_id) keptToolResultIds.add(block.tool_use_id);
          if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id) keptToolUseIds.add(block.id);
        }
      }

      for (const id of keptToolResultIds) {
        if (keptToolUseIds.has(id)) continue;
        const toolUseIndex = this._findToolUseIndex(messages, id);
        if (toolUseIndex >= 0 && !mustKeep.has(toolUseIndex)) {
          mustKeep.add(toolUseIndex);
          changed = true;
        }
      }
    }

    // Keep a contiguous suffix from the earliest required post-prefix message.
    const requiredAfterPrefix = [...mustKeep].filter(i => i >= keepFirstN);
    return requiredAfterPrefix.length ? Math.min(...requiredAfterPrefix) : cutIdx;
  }

  _contentBlocks(msg) {
    return msg && Array.isArray(msg.content) ? msg.content.filter(Boolean) : [];
  }

  _findToolUseIndex(messages, id) {
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const block of this._contentBlocks(messages[i])) {
        if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id === id) return i;
      }
    }
    return -1;
  }

  estimateSavings(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return { pct: 0, count: 0 };
    const { trimmed, originalCount } = this.trim(messages, options);
    return {
      pct:   Math.round((trimmed / originalCount) * 100),
      count: trimmed,
      originalCount
    };
  }
}

module.exports = HistoryTrimmer;
