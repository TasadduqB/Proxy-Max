/**
 * Cache Injector  (lossless, zero-risk)
 * Adds Anthropic prompt-cache breakpoints to the system prompt and tool
 * definitions so repeated prefixes cost ~10% on the Anthropic-native path.
 *
 * Safety invariants — this must never break a request:
 *   1. Anthropic allows at most 4 cache_control breakpoints per request.
 *      Claude Code already sets its own, so we COUNT existing breakpoints and
 *      only add within the remaining budget — we can never push a request over
 *      the limit and trigger an API error.
 *   2. We never remove or move an existing breakpoint, and never alter content.
 *      If a block already has cache_control we leave it exactly as-is.
 *   3. We only add cache hints — the text/tokens the model sees are unchanged.
 */

const MAX_BREAKPOINTS = 4;

function hasCC(block) { return !!(block && block.cache_control); }

function countBreakpoints(body) {
  let n = 0;
  if (Array.isArray(body.system)) n += body.system.filter(hasCC).length;
  if (Array.isArray(body.tools))  n += body.tools.filter(hasCC).length;
  for (const m of body.messages || []) {
    if (m && Array.isArray(m.content)) n += m.content.filter(hasCC).length;
  }
  return n;
}

class CacheInjector {
  /**
   * @param {object} body   - request body (a shallow-cloned copy is returned)
   * @param {string} kind   - provider kind ('bedrock' is the Anthropic-native path)
   * @returns {{ body: object, injected: number }}
   */
  inject(body, kind) {
    const CACHE = { type: 'ephemeral' };
    const result = { ...body };

    // Respect Anthropic's hard cap. Claude Code's own breakpoints count first.
    let budget = MAX_BREAKPOINTS - countBreakpoints(result);
    if (budget <= 0) return { body: result, injected: 0 };

    let injected = 0;

    // ── System prompt ── (only if it carries no breakpoint yet)
    if (budget > 0 && result.system) {
      if (typeof result.system === 'string' && result.system.length > 0) {
        result.system = [{ type: 'text', text: result.system, cache_control: CACHE }];
        injected++; budget--;
      } else if (Array.isArray(result.system) && result.system.length > 0) {
        const last = result.system[result.system.length - 1];
        if (!hasCC(last) && !result.system.some(hasCC)) {
          result.system = [...result.system.slice(0, -1), { ...last, cache_control: CACHE }];
          injected++; budget--;
        }
      }
    }

    // ── Tool definitions ── mark the last tool so the whole tool prefix caches.
    if (budget > 0 && Array.isArray(result.tools) && result.tools.length > 0) {
      if (!result.tools.some(hasCC)) {
        const last = result.tools[result.tools.length - 1];
        result.tools = [...result.tools.slice(0, -1), { ...last, cache_control: CACHE }];
        injected++; budget--;
      }
    }

    return { body: result, injected };
  }
}

module.exports = CacheInjector;
