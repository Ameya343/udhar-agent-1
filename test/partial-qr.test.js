// A customer who names an amount with a pay/QR intent gets a QR for exactly that amount, in any phrasing.
// Live 24 Oct (rev 45): Sarthak (baaki ₹60) wrote "meko 30 bhejna hai"; the AI read it as an order "Meko x30",
// then "qr bhejo" got the full ₹60, and "meko 30 ka bhejo" was another order line. All three are covered here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-24';
const T0 = Date.UTC(2026, 9, 24, 20, 35, 0);
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function owing60() {
  const s = C.freshShop('gupta', TODAY);
  s.shop.upiId = 'guptakirana@okaxis';
  const c = C.customerFromWhatsapp(s, '919156543102', 'Sarthak').cust;
  delete c.guest;
  C.runAction(s, 'owner', { text: 'sarthak 60 udhaar chaaval' });
  assert.equal(C.balance(s, c.id), 60);
  return { s, c };
}
function say(s, c, text, intent, at) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: at || T0, intent });
  return s.messages.slice(n).filter((m) => m.from === 'agent' && m.to === c.id);
}
const offer = (got) => got.find((m) => m.kind === 'pay-offer');
// what the live AI said for "meko 30 bhejna hai"
const LLM_ORDER = { intent: 'order', parser: 'llm', items: [{ name: 'Meko', qty: 30 }] };

test('live: "meko 30 bhejna hai" is a ₹30 QR even when the AI calls it an order', () => {
  for (const intent of [undefined, LLM_ORDER]) {
    const { s, c } = owing60();
    const got = say(s, c, 'meko 30 bhejna hai', intent);
    const o = offer(got);
    assert.ok(o, JSON.stringify(got.map((m) => m.text)));
    assert.equal(o.payAmount, 30);
    assert.match(o.text, /₹30 ka QR\. Baaki ₹30 baad mein\./);
    assert.ok(!s.orders || !(s.orders || []).some((x) => x.custId === c.id), 'no order made');
    assert.equal(C.balance(s, c.id), 60);
  }
});

test('live: "meko 30 ka bhejo" is a ₹30 QR, and "qr bhejo" with no number is the full baaki', () => {
  const { s, c } = owing60();
  assert.equal(offer(say(s, c, 'meko 30 ka bhejo', LLM_ORDER)).payAmount, 30);
  const full = offer(say(s, c, 'qr bhejo'));
  assert.equal(full.payAmount, undefined);
  assert.match(full.text, /Poore ₹60 ka UPI QR/);
});

test('every phrasing that names an amount with pay/QR intent gets that amount', () => {
  const ALL = ['30 ka QR', 'QR 30', '30 rs ka qr bhejo', 'abhi 30 dunga', '30 pay karunga', '₹30 bhejna hai', 'sirf 30', '30 hi de sakta hu',
    'pay 30', 'send QR for 30', '३० का QR', 'Rs 30 ka QR', 'mujhe 30 ka qr chahiye', '30 ka scanner bhejo', 'upi 30', 'QR bhejo 30 ka', '30 ka QR bhejo bhai'];
  for (const t of ALL) {
    const { s, c } = owing60();
    const got = say(s, c, t, LLM_ORDER);
    const o = offer(got);
    assert.ok(o, t + ' -> ' + JSON.stringify(got.map((m) => m.text)));
    assert.equal(o.payAmount, 30, t);
    assert.match(o.text, /₹30 ka QR\. Baaki ₹30 baad mein\./, t);
  }
});

test('more than the baaki: the existing confirm text; zero or negative: refused, no QR', () => {
  let { s, c } = owing60();
  assert.match(offer(say(s, c, '100 ka QR bhejo')).text, /baaki sirf ₹60 hai/);
  for (const t of ['0 ka QR', 'QR -30', '₹0 bhejna hai']) {
    ({ s, c } = owing60());
    const got = say(s, c, t);
    assert.ok(!offer(got), t);
    assert.match(got.map((m) => m.text).join('\n'), /0 se zyada/, t);
  }
});

test('a QR intent with an unclear number asks "Kitne ka QR bhejun?", and the reply picks the amount', () => {
  for (const t of ['30-40 ka QR', 'aadha ka QR bhejo', 'thoda kam ka QR', '30 ya 40 ka qr', 'QR 30.5']) {
    const { s, c } = owing60();
    const got = say(s, c, t);
    assert.ok(!offer(got), t);
    assert.match(got.map((m) => m.text).join('\n'), /Kitne ka QR bhejun\? Poora ₹60 ya kam\?/, t);
  }
  const { s, c } = owing60();
  say(s, c, 'aadha ka QR bhejo');
  assert.equal(offer(say(s, c, '30', undefined, T0 + 60000)).payAmount, 30);
  say(s, c, 'kuch ka QR bhejo', undefined, T0 + 120000);
  assert.match(offer(say(s, c, 'poora', undefined, T0 + 180000)).text, /Poore ₹60 ka UPI QR/);
});

test('not a pay-now: orders, promises, disputes and payments already made', () => {
  assert.equal(C.payNowAsk('aata 2 kilo bhejna hai'), null);
  assert.equal(C.payNowAsk('maggi 30 ka bhejo'), null);
  assert.equal(C.payNowAsk('kal 30 dunga'), null);
  assert.equal(C.payNowAsk('sirf 30 baaki hai'), null);
  assert.equal(C.payNowAsk('QR se 30 pay kar diya'), null);
  assert.equal(C.payNowAsk('30 bhej diya'), null);
  assert.equal(C.payNowAsk('kal dunga'), null);
  assert.deepEqual(C.payNowAsk('QR bhejo'), { amount: null });
});
