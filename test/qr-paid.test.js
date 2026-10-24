// After a UPI QR the customer is asked "Payment ho gaya? 1 / 2". "1" is a pending UPI claim the owner checks in the
// bank (haan / nahi); the khata changes only on the owner's haan. Without a QR waiting, "1" / "2" mean what they did.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-24';
const T0 = Date.UTC(2026, 9, 24, 20, 35, 0);

function owing60() {
  const s = C.freshShop('gupta', TODAY);
  s.shop.upiId = 'guptastore@okaxis';
  const c = C.customerFromWhatsapp(s, '919156543102', 'Sarthak').cust;
  delete c.guest;
  C.runAction(s, 'owner', { text: 'sarthak 60 udhaar chaaval' });
  return { s, c };
}
function say(s, c, text, at) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: at || T0 });
  return s.messages.slice(n).filter((m) => m.from === 'agent');
}
function owner(s, text) {
  const n = s.messages.length;
  C.runAction(s, 'owner', { text });
  return s.messages.slice(n).filter((m) => m.from === 'agent');
}
const toC = (got, c) => got.filter((m) => m.to === c.id);
const toO = (got) => got.filter((m) => m.to === 'owner');

test('a QR is followed by the numbered "Payment ho gaya?" line', () => {
  const { s, c } = owing60();
  const got = toC(say(s, c, 'qr bhejo'), c);
  const i = got.findIndex((m) => m.kind === 'pay-offer');
  assert.ok(i >= 0);
  assert.equal(got[i + 1].kind, 'paid-ask');
  assert.equal(got[i + 1].text, 'Payment ho gaya? Reply karein: 1 = ✅ Paid, 2 = ⏳ Abhi nahi');
});

test('"1" after a partial QR: owner asked, khata unchanged until haan, then receipt with new baaki', () => {
  const { s, c } = owing60();
  say(s, c, 'meko 30 bhejna hai');
  const got = say(s, c, '1', T0 + 60000);
  assert.equal(toC(got, c)[0].text, 'Dukaandaar check karke confirm karenge 🙏');
  assert.equal(toO(got)[0].text, '💳 Sarthak ne ₹30 UPI se bhejne ka bataya. Bank/GPay check karke haan/nahi bolein.');
  assert.equal(C.balance(s, c.id), 60, 'no auto-credit');
  const r = owner(s, 'haan');
  assert.equal(C.balance(s, c.id), 30);
  const rc = toC(r, c).find((m) => m.kind === 'receipt');
  assert.ok(rc); assert.match(rc.text, /₹30 UPI mil gaya/); assert.match(rc.text, /Abhi baaki: ₹30/);
});

test('words count too: "paid", "ho gaya", "bhej diya"', () => {
  for (const w of ['paid', 'ho gaya', 'bhej diya', 'Paid ✅']) {
    const { s, c } = owing60();
    say(s, c, 'qr bhejo');
    const got = say(s, c, w, T0 + 1000);
    assert.equal(toC(got, c)[0].text, 'Dukaandaar check karke confirm karenge 🙏', w);
    assert.equal(C.pendingClaims(s).length, 1, w);
  }
});

test('owner nahi: nothing written, customer asked to check', () => {
  const { s, c } = owing60();
  say(s, c, 'qr bhejo'); say(s, c, '1', T0 + 1000);
  const r = owner(s, 'nahi');
  assert.equal(C.balance(s, c.id), 60);
  assert.ok(toC(r, c).length === 1);
  assert.equal(C.pendingClaims(s).length, 0);
});

test('"2" / "abhi nahi" / "baad mein": a short reply, the owner hears nothing, no claim', () => {
  for (const w of ['2', 'abhi nahi', 'baad mein']) {
    const { s, c } = owing60();
    say(s, c, 'qr bhejo');
    const got = say(s, c, w, T0 + 1000);
    assert.equal(toC(got, c)[0].text, 'Theek hai, jab bhejein tab batayein 🙏', w);
    assert.equal(toO(got).length, 0, w);
    assert.equal(C.pendingClaims(s).length, 0, w);
  }
});

test('no QR waiting: "1" is not a payment claim', () => {
  const { s, c } = owing60();
  const got = say(s, c, '1');
  assert.ok(!got.some((m) => m.kind === 'upi-claim'));
  assert.equal(C.pendingClaims(s).length, 0);
});

test('the question expires: "1" hours later is not a claim', () => {
  const { s, c } = owing60();
  say(s, c, 'qr bhejo');
  say(s, c, '1', T0 + 3 * 60 * 60 * 1000);
  assert.equal(C.pendingClaims(s).length, 0);
});

test('a balance question while the QR is waiting still gets the hisaab', () => {
  const { s, c } = owing60();
  say(s, c, 'qr bhejo');
  const got = toC(say(s, c, 'kitna baaki hai', T0 + 1000), c);
  assert.ok(got.some((m) => m.kind === 'statement'));
});

test('owner ignores the haan/nahi: the UPI claim waits in the evening batch', () => {
  const { s, c } = owing60();
  say(s, c, 'qr bhejo'); say(s, c, '1', T0 + 1000);
  const k = C.pendingClaims(s)[0];
  assert.match(C.claimLabel(s, k), /UPI/);
  assert.equal(C.balance(s, c.id), 60);
});
