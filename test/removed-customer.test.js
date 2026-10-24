// Run: node --test test/
// Live bug (cnndwom1le, 24 Oct): a removed customer wrote "hi" (got the ack), then "kitns baki hsi" and got silence.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

function setup() {
  const st = C.createState('2026-10-24'); C.seedDemo(st);
  const c = st.customers[0]; return { st, c };
}

test('typo balance question "kitns baki hsi" reads as balance', () => {
  const { st, c } = setup();
  for (const t of ['kitns baki hsi', 'kitn baaki hai', 'kitnaa baki hai']) assert.strictEqual(C.customerIntentRules(st, c, t).intent, 'balance', t);
});

test('a removed customer never gets silence on a second message', () => {
  const { st, c } = setup();
  c.removed = true; c.removedAt = '2026-10-23T14:23:32.008Z';
  const now = Date.parse('2026-10-24T20:27:23Z');
  const first = C.handleCustomerMessage(st, c.id, 'hi', { now });
  assert.ok(first.some((m) => m.to === c.id), 'first message answered');
  const second = C.handleCustomerMessage(st, c.id, 'kitns baki hsi', { now: now + 5 * 60e3 });
  const reply = second.find((m) => m.to === c.id);
  assert.ok(reply, 'second message answered');
  assert.match(reply.text, /baaki/);
  assert.ok(second.some((m) => m.to === 'owner' && /kitns baki hsi/.test(m.text)), 'owner sees the text');
  const third = C.handleCustomerMessage(st, c.id, 'acha theek hai', { now: now + 6 * 60e3 });
  assert.ok(third.some((m) => m.to === c.id), 'third message answered');
});
