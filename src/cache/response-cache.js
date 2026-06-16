/**
 * Response Cache — lossless, exact-match.
 *
 * Keys on the semantically meaningful parts of the request (model + system +
 * messages + tools + sampling params). An identical request returns the exact
 * bytes of the previously captured upstream response (streaming SSE replays
 * verbatim), at zero upstream cost. With a TTL it never serves indefinitely
 * stale data. This cannot change what the model "saw" — it only avoids
 * re-asking an identical question — so it's safe for tool use, web search and
 * subagents.
 */

const crypto = require('crypto');

class ResponseCache {
  constructor(store) { this.store = store; }

  /**
   * @param {string} requestedModel  the model the CLI asked for (stable across pool attempts)
   * @param {object} body            the original request body (pre-optimization)
   */
  makeKey(requestedModel, body) {
    const subset = {
      model: requestedModel || body.model || '',
      system: body.system ?? null,
      messages: body.messages ?? [],
      tools: body.tools ?? null,
      tool_choice: body.tool_choice ?? null,
      max_tokens: body.max_tokens ?? null,
      temperature: body.temperature ?? null,
      top_p: body.top_p ?? null,
      top_k: body.top_k ?? null,
      stop_sequences: body.stop_sequences ?? null,
      thinking: body.thinking ?? null,
    };
    let json;
    try { json = JSON.stringify(subset); }
    catch { return null; } // non-serializable → don't cache
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  get(key) {
    if (!key) return null;
    return this.store.cacheGet(key);
  }

  set(key, data) {
    if (!key) return;
    this.store.cacheSet(key, data);
  }
}

module.exports = ResponseCache;
