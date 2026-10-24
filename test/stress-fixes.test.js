// Regression tests for the last two stress findings (test/stress/s500.js):
//   F5  cash-claim-not-noted: "मैंने ₹60 दे दिए" / "maine 200 de diye" (an amount handed over, no UPI word) is a cash claim
//   F10 list-edit-wrong: re-pricing a line and then removing it takes off the new price, not the old one
// and the whole harness, which must report no distinct bugs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-20';
function shop() {
  const s = C.freshShop('gupta', TODAY);
  for (const c of s.customers) if (c.phone) c.wa = true;
  return s;
}
function claimFor(text) {
  const s = shop();
  C.runAction(s, 'customer', { custId: 'C005', text, now: Date.UTC(2026, 9, 20, 8) });
  return { s, k: C.pendingClaims(s).filter((x) => x.custId === 'C005') };
}

test('F5: an amount handed over with no UPI word is a pending cash claim, in Hindi, Hinglish and Devanagari digits', () => {
  for (const [t, a] of [['मैंने ₹60 दे दिए', 60], ['maine 200 de diye', 200], ['maine Rs 450 de diye', 450], ['मैंने २०० दे दिए', 200], ['maine 300 cash de diye', 300]]) {
    const { k } = claimFor(t);
    assert.strictEqual(k.length, 1, t); assert.strictEqual(k[0].amount, a, t);
  }
});

test('F5: a UPI claim stays a UPI note for the owner, and words without an amount never claim the balance', () => {
  for (const t of ['maine 200 gpay kar diya', 'maine 200 bhej diye', '200 upi kar diya']) {
    const { s, k } = claimFor(t);
    assert.strictEqual(k.length, 0, t);
    assert.ok(s.messages.some((m) => m.to === 'owner' && /keh rahe hain unhone ₹200 pay kar diya/.test(m.text)), t);
  }
  assert.strictEqual(claimFor('Nudes de diya').k.length, 0);
});

test('F10: re-price a list line, then remove it: the new price comes off', () => {
  const s = shop();
  s.customers.push({ id: 'C900', name: 'Krish', key: 'krish', phone: '9822700900', wa: true, vpas: [], dueDate: null, createdAt: TODAY });
  C.runAction(s, 'owner', { text: 'Krish ki list: 1 kilo cheeni 45, sabun 40, doodh 30', source: 'text' });
  const t = s.txns[s.txns.length - 1];
  assert.strictEqual(t.amount, 115);
  C.runAction(s, 'owner', { text: 'Krish ki list mein cheeni 55 ka tha', source: 'text' });
  assert.strictEqual(t.amount, 125);
  C.runAction(s, 'owner', { text: 'Krish ki list se cheeni hata do', source: 'text' });
  assert.strictEqual(t.amount, 70);
  assert.ok(!t.voided);
});

test('stress harness: about 6,900 generated messages, no distinct bugs', { timeout: 120000 }, () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'stress', 's500.js')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const m = /distinct bugs (\d+)/.exec(out);
  assert.ok(m, out.slice(-500));
  assert.strictEqual(+m[1], 0, out.split('distinct bugs')[1].slice(0, 2000));
});
