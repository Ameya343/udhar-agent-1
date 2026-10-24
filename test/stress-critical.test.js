// Regression tests for the CRITICAL bugs in the stress-test audit (STRESS_TEST_BUGS.md).
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const shop = () => C.freshShop('gupta', '2026-10-20');
const say = (s, text) => { const m = s.messages.length; C.runAction(s, 'owner', { text }); return s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n'); };
const newTx = (s, n) => s.txns.slice(n).map((t) => t.type + ' ' + C.getCust(s, t.custId).name + ' ' + t.amount);

test('1. mixed udhaar and jama in one message: each person gets their own type', () => {
  const s = shop(); const n = s.txns.length;
  say(s, 'sharma ne 200 diye aur verma ne 300 ka saman liya');
  assert.deepStrictEqual(newTx(s, n), ['payment Sharma ji 200', 'credit Verma ji 300']);
});

test('2. amounts are split per person, never merged onto the first', () => {
  let s = shop(); let n = s.txns.length;
  say(s, 'Sharma ji 200 and Verma ji 300 and Rohan 50');
  assert.deepStrictEqual(newTx(s, n), ['credit Sharma ji 200', 'credit Verma ji 300', 'credit Rohan 50']);
  s = shop(); n = s.txns.length;
  say(s, 'pappu aur rohan dono ka 100 100');
  assert.deepStrictEqual(newTx(s, n), ['credit Pappu 100', 'credit Rohan 100']);
});

test('3. filler words are not names; a new name is asked before a khata opens', () => {
  let s = shop(); let n = s.txns.length; const c0 = s.customers.length;
  say(s, 'ummm haan wo sharma ji ... teen sau ka saman liya');
  assert.deepStrictEqual(newTx(s, n), ['credit Sharma ji 300']);
  assert.strictEqual(s.customers.length, c0);
  s = shop(); n = s.txns.length;
  const r = say(s, 'ummm haan wo Zubair ... teen sau ka saman liya');
  assert.match(r, /"Zubair" naya grahak hai\?/);
  assert.strictEqual(s.txns.length, n);
  assert.strictEqual(s.customers.length, c0);
  say(s, 'haan');
  assert.deepStrictEqual(newTx(s, n), ['credit Zubair 300']);
});

test('3. list commands never become customers or entries', () => {
  for (const t of ['list banao: atta 5 kg, cheeni 2 kg', 'list: atta 5 kg']) {
    const s = shop(); const n = s.txns.length; const c0 = s.customers.length;
    say(s, t);
    assert.strictEqual(s.txns.length, n, t);
    assert.strictEqual(s.customers.length, c0, t);
  }
});

test('4. a nameless correction: same amount says whose entry, a new amount is asked first', () => {
  let s = shop(); say(s, 'Sharma ji ne 340 ka saaman liya'); let n = s.txns.length; const c0 = s.customers.length;
  assert.match(say(s, 'nahi 340 hi tha'), /Sharma ji/);
  assert.strictEqual(s.txns.length, n); assert.strictEqual(s.customers.length, c0);
  s = shop(); say(s, 'Sharma ji ne 340 ka saaman liya'); n = s.txns.length;
  const r = say(s, 'sorry 430 tha');
  assert.match(r, /Sharma ji.*430 karun\?/);
  assert.strictEqual(s.txns.length, n);
  assert.strictEqual(s.txns[n - 1].amount, 340);
  assert.strictEqual(s.customers.length, c0);
});

test('5. diye / dile / advance without "ne" are jama', () => {
  let s = shop(); let n = s.txns.length;
  say(s, 'Iqbal bhai 2000 diye (advance)');
  assert.deepStrictEqual(newTx(s, n), ['payment Iqbal bhai 2000']);
  s = shop(); n = s.txns.length;
  say(s, 'Patil bhau ni 1000 dile');
  assert.deepStrictEqual(newTx(s, n), ['payment Patil bhau 1000']);
});

test('6. "200 kam karo" reduces after the owner confirms, never adds udhaar', () => {
  const s = shop(); const n = s.txns.length;
  const r = say(s, 'sharma ji ka 200 kam karo');
  assert.match(r, /200 kam karun\?/);
  assert.strictEqual(s.txns.length, n);
  say(s, 'haan');
  assert.ok(!s.txns.slice(n).some((t) => t.type === 'credit'));
});
