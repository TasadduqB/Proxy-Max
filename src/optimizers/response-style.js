/**
 * Response Style Optimizer — caveman-mode terse communication
 *
 * Injects terse-communication rules into the system prompt so the upstream
 * model responds in compressed prose. Three intensity levels:
 *   lite  — drop filler only, keep full sentences
 *   full  — classic caveman (default): fragments OK, articles stripped
 *   ultra — maximum compression with arrows and abbreviations
 *
 * ~75% output token savings on typical assistant prose. Technical accuracy,
 * code, and error strings are always preserved verbatim.
 *
 * Based on https://github.com/juliusbrussee/caveman
 *
 * The proxy injects this transparently — no client-side plugin needed.
 */

const RESPONSE_STYLE_LITE = `[RESPONSE STYLE — terse: lite]
No filler. No hedging. No pleasantries. Keep full sentences and articles. Cut: "sure/certainly/of course/happy to/I'd be happy to". Professional, tight.
[/RESPONSE STYLE]`;

const RESPONSE_STYLE_FULL = `[RESPONSE STYLE — caveman: full]
Terse. Smart caveman. Technical substance stays exact. Fluff dies.
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement-a-solution-for). No tool-call narration. No decorative tables/emoji unless asked. Standard acronyms OK (DB/API/HTTP). Technical terms, code, error strings: exact and unchanged.
Pattern: [thing] [action] [reason]. [next step].
Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is most likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use < not <=. Fix:"
Active every response. Off only: "stop caveman" or "normal mode".
EXCEPTION: Tool call \`input\` parameters must always be complete, exact JSON. Never abbreviate, omit, or compress any value inside \`input\` — full file_path, full content, always.
[/RESPONSE STYLE]`;

const RESPONSE_STYLE_ULTRA = `[RESPONSE STYLE — caveman: ultra]
Max compression. Arrows for causality (X → Y). Abbreviate prose (fn/impl/req/res/cfg/auth/DB/conn). One word when enough. Mandatory fragments. Code symbols, function names, API names, error strings: never abbreviated. Safety exception: expand for destructive ops, irreversible actions, multi-step sequences where order ambiguity could cause harm. EXCEPTION: Tool call \`input\` parameters must always be complete, exact JSON — never abbreviate, omit, or compress any value inside \`input\`.
[/RESPONSE STYLE]`;

const MODES = {
  lite:  RESPONSE_STYLE_LITE,
  full:  RESPONSE_STYLE_FULL,
  ultra: RESPONSE_STYLE_ULTRA,
};

const MARKER = '[RESPONSE STYLE';

const { injectIntoSystem } = require('./_inject-system');

class ResponseStyleOptimizer {
  /**
   * Inject response-style rules into the body's system prompt (idempotent —
   * skips if the marker is already present).
   * @param {object} body — Anthropic Messages API request body
   * @param {{ mode?: string }} options
   * @returns {{ body: object, injected: boolean, mode: string }}
   */
  inject(body, options = {}) {
    const mode = (options.mode || 'full').toLowerCase();
    const rules = MODES[mode];
    if (!rules) return { body, injected: false, mode };
    const injected = injectIntoSystem(body, rules, MARKER);
    return { body, injected, mode };
  }
}

module.exports = ResponseStyleOptimizer;
