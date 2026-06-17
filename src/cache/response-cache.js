/**
 * Response Cache — lossless, exact-match.
 *
 * Keys on the semantically meaningful parts of the request (model + system +
 * messages + tools + sampling params). An identical request returns the exact
 * bytes of the previously captured upstream response (streaming SSE replays
 * verbatim), at zero upstream cost. With a TTL it never serves indefinitely
 * stale data. Tool-call IDs are deliberately preserved in the key: replaying a
 * cached response across different tool_use/tool_result IDs can break Claude
 * Code's next turn.
 */

const crypto = require('crypto');

function normalizeForCache(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeForCache);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = normalizeForCache(v);
  return out;
}

function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new TypeError('circular structure');
    seen.add(v);
    if (Array.isArray(v)) {
      const arr = v.map(normalize);
      seen.delete(v);
      return arr;
    }
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (typeof v[k] !== 'undefined' && typeof v[k] !== 'function') out[k] = normalize(v[k]);
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(normalize(value));
}

class ResponseCache {
  constructor(store) { this.store = store; }

  /**
   * @param {string} requestedModel  the model the CLI asked for (stable across pool attempts)
   * @param {object} body            the original request body (pre-optimization)
   * @param {object} options         cache namespace details that affect replay safety
   */
  makeKey(requestedModel, body, options = {}) {
    const subset = {
      version: 3,
      model: requestedModel || body.model || '',
      provider: options.provider || null,
      upstreamModel: options.upstreamModel || null,
      optimizationVersion: options.optimizationVersion || null,
      stream: !!body.stream,
      system: normalizeForCache(body.system ?? null),
      messages: normalizeForCache(body.messages ?? []),
      tools: body.tools ?? null,
      tool_choice: body.tool_choice ?? null,
      max_tokens: body.max_tokens ?? null,
      temperature: body.temperature ?? null,
      top_p: body.top_p ?? null,
      top_k: body.top_k ?? null,
      stop_sequences: body.stop_sequences ?? null,
      thinking: body.thinking ?? null,
      output_config: body.output_config ?? null,
      response_format: body.response_format ?? null,
      context_management: body.context_management ?? null,
      container: body.container ?? null,
      betas: body.betas ?? null,
      anthropic_beta: body.anthropic_beta ?? null,
      service_tier: body.service_tier ?? null,
      metadata: body.metadata ?? null,
      routeMode: options.routeMode || null,
      cachePolicy: options.cachePolicy || null,
    };
    let json;
    try { json = stableStringify(subset); }
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
