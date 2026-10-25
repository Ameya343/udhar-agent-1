// Regression for the 10k stress run (S500_SCALE=1.5 S500_SEED=777 node test/stress/s500.js):
//   F6 bill-total-wrong: "Pappu: 2 maggi 28, sabun 40" with no rate remembered was read as three people
//   ("Pappu ₹2, Maggi ₹28, Sabun ₹40") and nothing was written. A known grocery word is an item, not a new person.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

function shop() {
  const s = C.freshShop('gupta', '2026-10-20');
  s.prices = {};
  for (const c of s.customers) if (c.phone) c.wa = true;
  return s;
}
const run = (s, text) => { const n = s.txns.length; C.runAction(s, 'owner', { text, source: 'text' }); return s.txns.slice(n); };

test('count before an item with no rate yet is a bill, not a list of people', () => {
  for (const t of ['Pappu: 2 maggi 28, sabun 40', 'pappu 2 maggi 28, sabun 40']) {
    const s = shop(); const tx = run(s, t);
    assert.deepStrictEqual(tx.map((x) => [x.custId, x.amount]), [['C003', 68]], t);
  }
  const s = shop(); assert.deepStrictEqual(run(s, 'Pappu: 3 sabun 120').map((x) => [x.custId, x.amount]), [['C003', 120]]);
});

test('an unknown person next to a known one is still asked about, never written', () => {
  for (const t of ['verma 250 raju 120', 'Pappu: 200 aur raju 300', 'Pappu: 20 raju 30']) {
    const s = shop(); assert.strictEqual(run(s, t).length, 0, t);
    assert.match(s.messages.filter((m) => m.to === 'owner').pop().text, /Raju kaun hai/);
  }
});
