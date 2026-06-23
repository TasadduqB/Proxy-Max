/**
 * Shared system-prompt injection used by the laziness and response-style
 * optimizers. Appends `rules` to the request's system prompt (string or
 * Anthropic array form), guarded by `marker` so it is idempotent — a system
 * prompt that already contains the marker is left untouched.
 *
 * @param {object} body   Anthropic Messages API request body (mutated in place)
 * @param {string} rules  the ruleset text to append
 * @param {string} marker substring that uniquely identifies an existing injection
 * @returns {boolean} true if the rules were injected, false if already present
 */
function injectIntoSystem(body, rules, marker) {
  if (typeof body.system === 'string') {
    if (body.system.includes(marker)) return false;
    body.system = body.system + '\n\n' + rules;
  } else if (Array.isArray(body.system)) {
    const alreadyPresent = body.system.some(
      block => block && block.type === 'text' && typeof block.text === 'string' && block.text.includes(marker)
    );
    if (alreadyPresent) return false;
    body.system = [...body.system, { type: 'text', text: '\n\n' + rules }];
  } else {
    body.system = rules;
  }
  return true;
}

module.exports = { injectIntoSystem };
