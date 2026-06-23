// Laziness/response-style optimizers must be idempotent: injecting twice into
// the same system prompt must not duplicate the ruleset (prevents unbounded
// growth / cache churn if a system prompt is ever re-submitted).
const assert = require('assert');
const LazinessOptimizer = require('./src/optimizers/laziness');
const ResponseStyleOptimizer = require('./src/optimizers/response-style');

let failures = 0;
function run(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ': ' + e.message); }
}

for (const [name, Opt] of [['laziness', LazinessOptimizer], ['response-style', ResponseStyleOptimizer]]) {
  run(name + ' string system idempotent', () => {
    const opt = new Opt();
    const body = { system: 'You are helpful.' };
    const r1 = opt.inject(body, { mode: 'full' });
    assert.strictEqual(r1.injected, true);
    const r2 = opt.inject(body, { mode: 'full' });
    assert.strictEqual(r2.injected, false, 'second inject should be a no-op');
  });

  run(name + ' array system idempotent', () => {
    const opt = new Opt();
    const body = { system: [{ type: 'text', text: 'You are helpful.' }] };
    opt.inject(body, { mode: 'full' });
    const before = body.system.length;
    const r2 = opt.inject(body, { mode: 'full' });
    assert.strictEqual(r2.injected, false, 'second inject should be a no-op');
    assert.strictEqual(body.system.length, before, 'should not append a second block');
  });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
