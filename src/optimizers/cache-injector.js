/**
 * Cache Injector  (lossless, zero-risk)
 * Adds Anthropic prompt-cache breakpoints to stable request prefixes.
 *
 * Safety invariants — this must never break a request:
 *   1. Anthropic allows at most 4 cache_control breakpoints per request.
 *      Claude Code already sets its own, so we count existing breakpoints and
 *      only add within the remaining budget.
 *   2. We never remove or move an existing breakpoint, and never alter content.
 *   3. We only add cache hints — the text/tokens the model sees are unchanged.
 */

const MAX_BREAKPOINTS = 4;

function hasCC(block) { return !!(block && block.cache_control); }
function approxTokens(value) {
  if (!value) return 0;
  try { return Math.ceil(JSON.stringify(value).length / 4); }
  catch { return Math.ceil(String(value).length / 4); }
}
function cacheControl(ttl) {
  const cc = { type: 'ephemeral' };
  if (ttl === '1h') cc.ttl = '1h';
  return cc;
}

function countBreakpoints(body) {
  let n = 0;
  if (Array.isArray(body.system)) n += body.system.filter(hasCC).length;
  if (Array.isArray(body.tools))  n += body.tools.filter(hasCC).length;
  for (const m of body.messages || []) {
    if (m && Array.isArray(m.content)) n += m.content.filter(hasCC).length;
  }
  return n;
}

function stripCacheControl(body) {
  const out = { ...body };
  let stripped = 0;
  if (out.system && Array.isArray(out.system)) {
    out.system = out.system.map(blk => {
      if (!hasCC(blk)) return blk;
      stripped++;
      const { cache_control, ...rest } = blk;
      return rest;
    });
  }
  if (out.messages) {
    out.messages = out.messages.map(msg => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.map(blk => {
            if (!hasCC(blk)) return blk;
            stripped++;
            const { cache_control, ...rest } = blk;
            return rest;
          })
        : msg.content
    }));
  }
  if (out.tools) {
    out.tools = out.tools.map(t => {
      if (!hasCC(t)) return t;
      stripped++;
      const { cache_control, ...rest } = t;
      return rest;
    });
  }
  return { body: out, stripped };
}

class CacheInjector {
  /**
   * @param {object} body   - request body (a shallow-cloned copy is returned)
   * @param {string} kind   - provider kind ('bedrock' is the Anthropic-native path)
   * @param {object} options
   * @returns {{ body: object, injected: number, preserved: number, stripped: number, unsupported: boolean, cacheablePrefixTokens: number }}
   */
  inject(body, kind, options = {}) {
    const nativeSupported = kind === 'bedrock' || options.nativeSupported === true;
    if (!nativeSupported) {
      const stripped = stripCacheControl(body);
      return { body: stripped.body, injected: 0, preserved: 0, stripped: stripped.stripped, unsupported: true, cacheablePrefixTokens: 0 };
    }

    const CACHE = cacheControl(options.ttl || '5m');
    const minTokens = Math.max(0, Number(options.minTokens) || 256);
    const result = { ...body };
    const preserved = countBreakpoints(result);

    let budget = MAX_BREAKPOINTS - preserved;
    if (budget <= 0) return { body: result, injected: 0, preserved, stripped: 0, unsupported: false, cacheablePrefixTokens: approxTokens(result.system) + approxTokens(result.tools) };

    let injected = 0;
    let cacheablePrefixTokens = 0;

    // Tool definitions are the most stable and usually largest prefix in Claude Code.
    if (budget > 0 && Array.isArray(result.tools) && result.tools.length > 0) {
      cacheablePrefixTokens += approxTokens(result.tools);
      if (!result.tools.some(hasCC) && approxTokens(result.tools) >= minTokens) {
        const last = result.tools[result.tools.length - 1];
        result.tools = [...result.tools.slice(0, -1), { ...last, cache_control: CACHE }];
        injected++; budget--;
      }
    }

    // System prompt comes before messages and is stable across turns.
    if (budget > 0 && result.system) {
      cacheablePrefixTokens += approxTokens(result.system);
      if (typeof result.system === 'string' && result.system.length > 0 && approxTokens(result.system) >= minTokens) {
        result.system = [{ type: 'text', text: result.system, cache_control: CACHE }];
        injected++; budget--;
      } else if (Array.isArray(result.system) && result.system.length > 0) {
        const last = result.system[result.system.length - 1];
        if (!hasCC(last) && !result.system.some(hasCC) && approxTokens(result.system) >= minTokens) {
          result.system = [...result.system.slice(0, -1), { ...last, cache_control: CACHE }];
          injected++; budget--;
        }
      }
    }

    // Message-level breakpoints help long Claude Code sessions when provider-native
    // prompt caching is available. Prefer older stable user/tool-result boundaries,
    // not the newest turn that will change immediately.
    if (budget > 0 && Array.isArray(result.messages) && result.messages.length >= 8) {
      const nextMessages = [...result.messages];
      const candidates = [];
      for (let i = 0; i < nextMessages.length - 2; i++) {
        const msg = nextMessages[i];
        if (!msg || !Array.isArray(msg.content) || msg.content.some(hasCC)) continue;
        const toks = approxTokens(msg.content);
        if (toks < minTokens) continue;
        if (msg.role === 'user' || msg.role === 'assistant') candidates.push({ i, toks });
      }
      candidates.sort((a, b) => b.toks - a.toks);
      for (const c of candidates) {
        if (budget <= 0) break;
        const msg = nextMessages[c.i];
        const content = [...msg.content];
        const idx = content.length - 1;
        if (idx < 0 || hasCC(content[idx])) continue;
        content[idx] = { ...content[idx], cache_control: CACHE };
        nextMessages[c.i] = { ...msg, content };
        cacheablePrefixTokens += c.toks;
        injected++; budget--;
      }
      result.messages = nextMessages;
    }

    return { body: result, injected, preserved, stripped: 0, unsupported: false, cacheablePrefixTokens };
  }

  strip(body) { return stripCacheControl(body); }
}

module.exports = CacheInjector;
