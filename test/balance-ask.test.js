// A customer with an order waiting on "Udhaar mein likhein? Haan/Nahi" asked "mera kitna udhaar hau" and the bot took it
// as the udhaar answer. A balance question is answered as one; only a short bare reply answers the ask.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-18';
let clock = Date.UTC(2026, 9, 18, 18, 55, 0);
function setup() {
  const s = C.freshShop('gupta', TODAY);
  s.prices.chaval = { name: 'chaaval', rate: 60, unit: 'kg', date: '2026-10-17' };
  const c = C.customerFromWhatsapp(s, '9000003199', 'Sarthak seth').cust;
  C.runAction(s, 'owner', { text: 'ok' });
  say(s, c, 'ek kilo chaaval');
  return { s, c };
}
function say(s, c, text, intent) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: (clock += 60000), intent: intent ? { intent, method: '', amount: null, parser: 'llm' } : undefined });
  return s.messages.slice(n).filter((m) => m.from === 'agent' && m.to === c.id).map((m) => m.text).join('\n');
}
const status = (s, c) => s.orders.filter((o) => o.custId === c.id).pop().status;

for (const q of ['mera kitna udhaar hau', 'mera kitna udhaar hai', 'kitna baaki hai', 'kitna baki hau']) {
  test('"' + q + '" with an order in ask is a balance question, not the udhaar answer', () => {
    const { s, c } = setup();
    assert.strictEqual(status(s, c), 'ask');
    const r = say(s, c, q);
    assert.doesNotMatch(r, /Theek hai, udhaar par/);
    assert.strictEqual(status(s, c), 'ask');
  });
}
// "haan" reaches the ask as the AI's confirm_yes (the rules alone leave a bare "haan" to the reminder, as before)
for (const [a, intent] of [['haan', 'confirm_yes'], ['ha ji', 'confirm_yes'], ['udhaar', undefined], ['haan udhaar likho', undefined]]) {
  test('"' + a + '" still answers the ask as udhaar', () => {
    const { s, c } = setup();
    say(s, c, a, intent);
    assert.notStrictEqual(status(s, c), 'ask');
  });
}
test('a balance question still wins when the AI reads it as confirm_yes', () => {
  const { s, c } = setup();
  say(s, c, 'mera kitna udhaar hau', 'confirm_yes');
  assert.strictEqual(status(s, c), 'ask');
});
test('demo okaxis UPI IDs are placeholders', () => {
  for (const u of ['guptakirana@okaxis', 'ramesh.sharma@okaxis', 'salim.k@okaxis', 'yourname@okaxis']) {
    assert.ok(C.isPlaceholderUpi(u), u);
    assert.strictEqual(C.validUpi(u), null);
  }
  assert.ok(!C.isPlaceholderUpi('realshop@okaxis'));
});
