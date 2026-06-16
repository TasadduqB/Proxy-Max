/**
 * History Trimmer
 * Trims the messages array to a configurable sliding window.
 * Keeps the first keepFirstN messages (initial context exchange) plus
 * the last (maxMessages - keepFirstN) messages.
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
    const trimmedRest = rest.length > keepLast ? rest.slice(rest.length - keepLast) : rest;
    const trimmed = rest.length - trimmedRest.length;

    return { messages: [...first, ...trimmedRest], trimmed, originalCount };
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
