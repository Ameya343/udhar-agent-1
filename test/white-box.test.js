// White-box tests: branches, boundary values and error paths that the feature tests did not reach.
// Covers pay amounts (0, minus, huge, Devanagari digits), the QR ask clock, paidAsk expiry exactly at the limit,
// cash claims, the evening batch, removed customers, balance typos, UPI placeholders, auth (GSTIN / PAN, phone,
// passwords, lockout, sessions, tax id sealing) and the LLM chain (JSON extraction, fallback, circuit breaker).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const A = require('../dist-server/server/auth.js');
const { createLlm, extractJson } = require('../dist-server/server/llm.js');
const { createBrain } = require('../dist-server/server/brain.js');

const TODAY = '2026-10-24';
// a clock far from the real one, so any Date.now() mixed into a simulated-time path shows up
const T = Date.UTC(2031, 0, 5, 10, 0, 0);
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function owing60() {
  const s = C.freshShop('gupta', TODAY);
  s.shop.upiId = 'guptastore@okaxis';
  const c = C.customerFromWhatsapp(s, '919156543102', 'Sarthak').cust;
  delete c.guest;
  C.runAction(s, 'owner', { text: 'sarthak 60 udhaar chaaval' });
  assert.equal(C.balance(s, c.id), 60);
  return { s, c };
}
function say(s, c, text, at) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: at || T });
  return s.messages.slice(n).filter((m) => m.from === 'agent');
}
const toCust = (got, c) => got.filter((m) => m.to === c.id);
const offer = (got) => got.find((m) => m.kind === 'pay-offer');

// ---------------------------------------------------------------- payAmount
test('payAmount: empty / null is the full baaki', () => {
  const { s, c } = owing60();
  for (const v of ['', null, undefined, '  ']) {
    const p = C.payAmount(s, c.id, v);
    assert.equal(p.ok, true); assert.equal(p.amount, 60); assert.equal(p.full, true);
  }
});
test('payAmount: boundaries 0, 1, baaki, baaki+1, cap, cap+1', () => {
  const { s, c } = owing60();
  assert.equal(C.payAmount(s, c.id, '0').error, 'zero');
  assert.equal(C.payAmount(s, c.id, '1').amount, 1);
  assert.equal(C.payAmount(s, c.id, '60').full, true);
  assert.equal(C.payAmount(s, c.id, '61').error, 'over');
  assert.equal(C.payAmount(s, c.id, '61', { over: true }).extra, 1);
  assert.equal(C.payAmount(s, c.id, String(C.UPI_MAX), { over: true }).ok, true);
  assert.equal(C.payAmount(s, c.id, String(C.UPI_MAX + 1), { over: true }).error, 'too-big');
  assert.equal(C.payAmount(s, c.id, '9999999999').error, 'not-number'); // 10 digits
});
test('payAmount: formats (₹, commas, Rs., /-, paise) and junk', () => {
  const { s, c } = owing60();
  assert.equal(C.payAmount(s, c.id, '₹50').amount, 50);
  assert.equal(C.payAmount(s, c.id, 'Rs. 50').amount, 50);
  assert.equal(C.payAmount(s, c.id, 'INR50').amount, 50);
  assert.equal(C.payAmount(s, c.id, '50/-').amount, 50);
  assert.equal(C.payAmount(s, c.id, '50.00').amount, 50);
  assert.equal(C.payAmount(s, c.id, '50.5').error, 'paise');
  assert.equal(C.payAmount(s, c.id, '-5').error, 'not-number');
  assert.equal(C.payAmount(s, c.id, '1e2').error, 'not-number');
  assert.equal(C.payAmount(s, c.id, 'abc').error, 'not-number');
});
test('bug fix: payAmount reads Devanagari digits ("५०" is ₹50)', () => {
  const { s, c } = owing60();
  const p = C.payAmount(s, c.id, '५०');
  assert.equal(p.ok, true); assert.equal(p.amount, 50);
  assert.equal(C.payAmount(s, c.id, '₹६०').full, true);
});
test('payAmount: nothing due', () => {
  const s = C.freshShop('gupta', TODAY);
  const c = C.customerFromWhatsapp(s, '919156543102', 'Sarthak').cust;
  assert.equal(C.payAmount(s, c.id, '10').error, 'none-due');
});

// ---------------------------------------------------------------- UPI id
test('validUpi / placeholder UPI', () => {
  assert.equal(C.validUpi(' GuptaStore@OkAxis '), 'guptastore@okaxis');
  assert.equal(C.validUpi('9876543210@ybl'), '9876543210@ybl');
  for (const bad of ['', null, undefined, 'a@b', 'ab@1x', 'x.y@ok-axis', 'no-at-sign', '@okaxis', 'ab@', 'yourname@okaxis', 'GUPTAKIRANA@UPI'])
    assert.equal(C.validUpi(bad), null, String(bad));
  assert.equal(C.isPlaceholderUpi(' Salim.K@okaxis '), true);
  assert.equal(C.isPlaceholderUpi(null), false);
  const s = C.freshShop('gupta', TODAY);
  s.shop.upiId = 'yourname@okaxis';
  assert.equal(C.shopUpi(s), '');
  assert.equal(C.upiLink(s, { id: 'C1' }, 10), '');
  s.shop.upiId = 'real.shop@oksbi';
  assert.match(C.upiLink(s, { id: 'C1' }, 10.6), /^upi:\/\/pay\?pa=real\.shop%40oksbi&.*&am=11&cu=INR&tn=UDH-C1$/);
});

// ---------------------------------------------------------------- pay-now asks
test('payNowAsk: zero, minus, ranges, fuzzy, paise, past tense, units', () => {
  assert.deepEqual(C.payNowAsk('0 ka qr'), { amount: 0, bad: true });
  assert.deepEqual(C.payNowAsk('-30 ka qr'), { amount: -30, bad: true });
  assert.equal(C.payNowAsk('30-40 ka qr').ask, true);
  assert.equal(C.payNowAsk('aadha ka qr').ask, true);
  assert.equal(C.payNowAsk('30.5 ka qr').ask, true);
  assert.equal(C.payNowAsk('30 ka qr bhej diya'), null);
  assert.equal(C.payNowAsk('2 kg qr'), null);
  assert.equal(C.payNowAsk('kal 30 dunga'), null);
  assert.deepEqual(C.payNowAsk('३० का QR'), { amount: 30, weak: false });
  assert.deepEqual(C.payNowAsk('qr 1,000'), { amount: 1000, weak: false });
  assert.equal(C.payNowAsk(''), null);
  assert.equal(C.payNowAsk(null), null);
});
test('bug fix: after "0 ka qr", the reply "50" gets a ₹50 QR on the message clock (was compared with the wall clock)', () => {
  const { s, c } = owing60();
  const first = toCust(say(s, c, '0 ka qr', T), c);
  assert.match(first[0].text, /0 se zyada/);
  const got = say(s, c, '50', T + 60e3);
  const o = offer(got);
  assert.ok(o, JSON.stringify(got.map((m) => m.text)));
  assert.equal(o.payAmount, 50);
});
test('bug fix: "qr 5000000" is asked again, not swapped for a ₹60 QR', () => {
  const { s, c } = owing60();
  const got = toCust(say(s, c, 'qr 5000000'), c);
  assert.ok(!offer(got), 'no QR for a typo amount');
  assert.equal(got[0].kind, 'pay-ask');
  assert.match(got[0].text, /₹50,00,000.*₹1,00,000 tak/);
  const then = offer(say(s, c, '50', T + 1000));
  assert.ok(then); assert.equal(then.payAmount, 50);
});
test('QR ask answer: exactly at 30 min the ask has closed', () => {
  const { s, c } = owing60();
  say(s, c, 'aadha ka qr', T);
  assert.ok(!offer(say(s, c, '30', T + 30 * 60e3)));
  const r = owing60();
  say(r.s, r.c, 'aadha ka qr', T);
  assert.ok(offer(say(r.s, r.c, '30', T + 30 * 60e3 - 1)));
});
test('QR ask answer "poora" is the full baaki; Devanagari "३०" is ₹30', () => {
  let { s, c } = owing60();
  say(s, c, 'aadha ka qr', T);
  let o = offer(say(s, c, 'poora', T + 1000));
  assert.ok(o); assert.equal(o.payAmount, undefined); assert.equal(o.amount, 60);
  ({ s, c } = owing60());
  say(s, c, 'आधा का QR', T);
  o = offer(say(s, c, '३०', T + 1000));
  assert.equal(o.payAmount, 30);
});
test('pay ask with nothing due', () => {
  const s = C.freshShop('gupta', TODAY);
  s.shop.upiId = 'guptastore@okaxis';
  const c = C.customerFromWhatsapp(s, '919156543102', 'Sarthak').cust;
  delete c.guest;
  const got = toCust(say(s, c, 'aadha ka qr'), c);
  assert.match(got[0].text, /koi baaki nahi/);
});
test('no shop UPI (placeholder): cash only, owner told once', () => {
  const { s, c } = owing60();
  s.shop.upiId = 'guptakirana@upi';
  const got = say(s, c, 'qr bhejo');
  assert.ok(!offer(got));
  assert.ok(got.some((m) => m.to === c.id && /UPI abhi set nahi/.test(m.text)));
  assert.equal(got.filter((m) => m.to === 'owner' && /UPI ID set nahi/.test(m.text)).length, 1);
  const again = say(s, c, 'qr bhejo', T + 1000);
  assert.equal(again.filter((m) => m.to === 'owner' && /UPI ID set nahi/.test(m.text)).length, 0);
});

// ---------------------------------------------------------------- paidAsk (1 / 2 after a QR)
test('paidAsk: "1" one ms before 2 h is a UPI claim; exactly at 2 h it has expired', () => {
  let { s, c } = owing60();
  say(s, c, 'qr bhejo', T);
  let got = say(s, c, '1', T + 2 * 3600e3 - 1);
  assert.ok(got.some((m) => m.kind === 'upi-claim'));
  assert.equal(s.pending.what, 'upi-claim');
  ({ s, c } = owing60());
  say(s, c, 'qr bhejo', T);
  got = say(s, c, '1', T + 2 * 3600e3);
  assert.ok(!got.some((m) => m.kind === 'upi-claim'));
});
test('paidAsk: "2" is later, a second "1" after a fresh QR does not open a second claim', () => {
  const { s, c } = owing60();
  say(s, c, 'qr bhejo', T);
  assert.equal(say(s, c, 'abhi nahi', T + 1000)[0].kind, 'paid-later');
  say(s, c, 'qr bhejo', T + 2000);
  say(s, c, 'paid', T + 3000);
  say(s, c, 'qr bhejo', T + 4000);
  const got = say(s, c, '1', T + 5000);
  assert.ok(!got.some((m) => m.kind === 'upi-claim'));
  assert.equal(s.cashClaims.filter((k) => k.method === 'upi').length, 1);
});
test('upi-claim: owner haan writes the payment and sends a receipt; nahi writes nothing', () => {
  let { s, c } = owing60();
  say(s, c, '30 ka qr', T);
  say(s, c, '1', T + 1000);
  C.runAction(s, 'owner', { text: 'haan' });
  assert.equal(C.balance(s, c.id), 30);
  ({ s, c } = owing60());
  say(s, c, 'qr bhejo', T);
  say(s, c, '1', T + 1000);
  C.runAction(s, 'owner', { text: 'nahi' });
  assert.equal(C.balance(s, c.id), 60);
});

// ---------------------------------------------------------------- cash claims + evening batch
test('cash claim: amount is pending until the owner confirms in the evening batch', () => {
  const { s, c } = owing60();
  const got = toCust(say(s, c, '40 cash de diya'), c);
  assert.equal(got[0].kind, 'cash-noted');
  assert.equal(C.balance(s, c.id), 60);
  assert.equal(C.pendingCash(s, c.id), 40);
  // a repeat inside the window is not a second claim
  assert.match(toCust(say(s, c, '40 cash de diya', T + 1000), c)[0].text, /dukaandaar ke paas hai/);
  const eve = C.runEveningSummary(s);
  const batch = eve.find((m) => m.kind === 'cash-confirm');
  assert.ok(batch); assert.equal(batch.claimIds.length, 1);
  assert.deepEqual(C.runEveningSummary(s), [], 'once per day');
  C.confirmCash(s, batch.claimIds[0], true);
  assert.equal(C.balance(s, c.id), 20);
  assert.deepEqual(C.confirmCash(s, batch.claimIds[0], true), [], 'a resolved claim is not applied twice');
  assert.deepEqual(C.confirmCash(s, 'K-nope', true), []);
});
test('cash claim with no amount is the baaki left after pending claims', () => {
  const { s, c } = owing60();
  say(s, c, 'cash de diya');
  assert.equal(C.pendingCash(s, c.id), 60);
});
test('bug fix: "-20 cash de diya" is asked, not noted as ₹20', () => {
  const { s, c } = owing60();
  const got = toCust(say(s, c, '-20 cash de diya'), c);
  assert.equal(got[0].kind, 'cash-ask');
  assert.equal(C.pendingCash(s, c.id), 0);
});
test('bug fix: "0 cash de diya" is asked, not noted as the full ₹60', () => {
  const { s, c } = owing60();
  const got = toCust(say(s, c, '0 cash de diya'), c);
  assert.equal(got[0].kind, 'cash-ask');
  assert.equal(C.pendingCash(s, c.id), 0);
});
test('evening batch: no pending claims, only the summary', () => {
  const { s } = owing60();
  const eve = C.runEveningSummary(s);
  assert.equal(eve.length, 1); assert.equal(eve[0].kind, 'evening');
});

// ---------------------------------------------------------------- balance intent typos
test('balance questions in Hinglish typos, Devanagari and English', () => {
  for (const t of ['kitna baaki hai', 'kitns baki hsi', 'mera kitna udhaar hau', 'कितना बाकी है', 'kitna udhar h', 'How much do I owe?']) {
    const { s, c } = owing60();
    const got = toCust(say(s, c, t), c);
    assert.ok(got.some((m) => m.kind === 'statement' && /₹60 baaki/.test(m.text)), t);
  }
});

// ---------------------------------------------------------------- removed customers
test('removed customer: 12 h repeat window, exactly at the limit the long line comes back', () => {
  const { s, c } = owing60();
  c.removed = true;
  const a = say(s, c, 'hi', T);
  assert.ok(a.some((m) => m.to === 'owner' && m.kind === 'owner-ask'));
  const b = toCust(say(s, c, 'hello', T + 1000), c);
  assert.match(b[0].text, /tak pahuncha diya/);
  const d = toCust(say(s, c, 'hello', T + 1000 + 12 * 3600e3), c);
  assert.match(d[0].text, /^Namaste/);
  // balance stays readable
  const e = toCust(say(s, c, 'kitna baaki hai', T + 13 * 3600e3), c);
  assert.equal(e[0].balance, 60);
});
test('removed customer: owner nahi to rejoin is not asked again that day', () => {
  const { s, c } = owing60();
  c.removed = true;
  say(s, c, 'hi', T);
  C.runAction(s, 'owner', { text: 'nahi' });
  assert.equal(c.rejoinDeclined, s.today);
  const got = say(s, c, 'hi', T + 1000);
  assert.ok(!got.some((m) => m.kind === 'owner-ask'));
  assert.ok(got.some((m) => m.to === 'owner' && /hataye gaye/.test(m.text)));
});

// ---------------------------------------------------------------- owner amounts
test('owner entries: 0 not understood, minus asked, huge amounts confirmed first', () => {
  let { s, c } = owing60();
  C.runAction(s, 'owner', { text: 'sarthak 0 udhaar' });
  assert.equal(C.balance(s, c.id), 60);
  ({ s, c } = owing60());
  C.runAction(s, 'owner', { text: 'sarthak -50 udhaar' });
  assert.equal(C.balance(s, c.id), 60);
  ({ s, c } = owing60());
  C.runAction(s, 'owner', { text: 'sarthak 99999999 udhaar' });
  assert.equal(C.balance(s, c.id), 60, 'asked first');
  C.runAction(s, 'owner', { text: 'nahi' });
  assert.equal(C.balance(s, c.id), 60);
  assert.throws(() => C.runAction(s, 'owner', { text: '' }), /text required/);
});

// ---------------------------------------------------------------- auth: validation
const GSTIN = '27AAPFU0939F1ZV';
const withCheck = (first14) => first14 + A.gstinCheckChar(first14);
test('GSTIN: valid, lower case and spaces cleaned', () => {
  assert.deepEqual(A.checkGstin(GSTIN), { ok: true, value: GSTIN });
  assert.deepEqual(A.checkGstin(' 27aapfu0939f1zv '), { ok: true, value: GSTIN });
  assert.deepEqual(A.checkGstin('27 AAPFU 0939F 1ZV'), { ok: true, value: GSTIN });
});
test('GSTIN: length, format, state code boundaries, PAN and check character', () => {
  assert.match(A.checkGstin('').error, /15 characters/);
  assert.match(A.checkGstin(null).error, /15 characters/);
  assert.match(A.checkGstin(GSTIN + 'X').error, /15 characters/);
  assert.match(A.checkGstin('27AAPFU0939F1YV').error, /format/); // 14th must be Z
  assert.match(A.checkGstin('27AAPFU0939F0ZV').error, /format/); // entity 0 not allowed
  for (const st of ['01', '38', '97', '99']) assert.equal(A.checkGstin(withCheck(st + 'AAPFU0939F1Z')).ok, true, st);
  for (const st of ['00', '39', '96', '98']) assert.match(A.checkGstin(withCheck(st + 'AAPFU0939F1Z')).error, /state code/, st);
  assert.match(A.checkGstin('27AAPFU0939F1ZA').error, /check character/);
  assert.match(A.checkGstin('२७AAPFU0939F1ZV').error, /15 characters|format/);
});
test('PAN', () => {
  assert.equal(A.validPan('abcde1234f'), 'ABCDE1234F');
  assert.equal(A.validPan(' ABCDE 1234 F '), 'ABCDE1234F');
  for (const bad of ['', null, 'ABCD1234F', 'ABCDE12345', 'ABCDE1234FF', '12345ABCDE']) assert.equal(A.validPan(bad), null, String(bad));
});
test('normPhone: prefixes and boundaries', () => {
  assert.equal(A.normPhone('+91 98765 43210'), '9876543210');
  assert.equal(A.normPhone('09876543210'), '9876543210');
  assert.equal(A.normPhone('919876543210'), '9876543210');
  assert.equal(A.normPhone('6000000000'), '6000000000');
  for (const bad of ['5876543210', '987654321', '98765432101', '', null, 'abc']) assert.equal(A.normPhone(bad), null, String(bad));
});
test('passwordProblem and mask', () => {
  assert.match(A.passwordProblem(undefined), /required/);
  assert.match(A.passwordProblem(123456), /required/);
  assert.match(A.passwordProblem('12345'), /at least 6/);
  assert.equal(A.passwordProblem('a1b2c3'), null);
  assert.match(A.passwordProblem('x'.repeat(201)), /too long/);
  assert.equal(A.passwordProblem('x'.repeat(200)), null);
  for (const p of ['000000', '111111', '123456', '654321']) assert.match(A.passwordProblem(p), /less obvious/);
  assert.equal(A.mask(''), '');
  assert.equal(A.mask(null), '');
  assert.equal(A.mask('ab'), 'ab');
  assert.equal(A.mask('9876543210'), 'XXXXXX3210');
  assert.equal(A.mask('1ZV9', 15), 'XXXXXXXXXXX1ZV9');
});
test('password hashing: wrong, corrupt and foreign stored hashes are false, never throw', () => {
  const h = A.hashPassword('secret1');
  assert.equal(A.verifyPassword('secret1', h), true);
  assert.equal(A.verifyPassword('secret2', h), false);
  assert.equal(A.verifyPassword('secret1', ''), false);
  assert.equal(A.verifyPassword('secret1', 'bcrypt$1$2$3$4$5'), false);
  assert.equal(A.verifyPassword('secret1', 'scrypt$notanumber$8$1$AAAA$AAAA'), false);
});
test('tax id sealing: plain without key, AES with key, wrong key or tampering is null', () => {
  assert.equal(A.sealTaxId(GSTIN, {}), 'plain:' + GSTIN);
  assert.equal(A.openTaxId('plain:' + GSTIN, {}), GSTIN);
  const env = { TAX_ID_KEY: 'k1' };
  const sealed = A.sealTaxId(GSTIN, env);
  assert.match(sealed, /^enc:v1:/);
  assert.equal(A.openTaxId(sealed, env), GSTIN);
  assert.equal(A.openTaxId(sealed, { TAX_ID_KEY: 'k2' }), null);
  assert.equal(A.openTaxId(sealed, {}), null);
  const parts = sealed.split(':');
  parts[4] = Buffer.from('tampered').toString('base64');
  assert.equal(A.openTaxId(parts.join(':'), env), null);
  assert.equal(A.openTaxId(null, env), null);
  assert.equal(A.openTaxId('junk', env), null);
});

// ---------------------------------------------------------------- auth: flows (in-memory store)
function memStore() { let d = { owners: [], sessions: [], profile: null }; return { load: () => d, save: (x) => { d = x; }, flush: async () => {}, close: async () => {} }; }
const PROFILE = { shopName: 'Gupta Kirana', ownerName: 'Ramesh Gupta', address: '12 Main Road', gstRegistered: true, gstin: GSTIN };
function authed(envExtra) {
  const clock = { t: Date.UTC(2026, 9, 24, 10) };
  const auth = A.createAuth({ env: Object.assign({ ADMIN_KEY: 'k' }, envExtra || {}), store: memStore(), now: () => clock.t });
  return { auth, clock };
}
const cookie = (r) => r.cookie.split(';')[0];
test('setup: admin key, single owner, phone, password and profile checks', () => {
  assert.equal(A.createAuth({ env: {}, store: memStore() }).setup({}, true).code, 403);
  const { auth } = authed();
  assert.equal(auth.setup({}, false).code, 403);
  assert.equal(auth.setup(Object.assign({ phone: '123', password: 'goodpw1' }, PROFILE), true).code, 400);
  assert.equal(auth.setup(Object.assign({ phone: '9876543210', password: '111111' }, PROFILE), true).code, 400);
  assert.match(auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE, { shopName: '  ' }), true).error, /Shop name/);
  assert.match(auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE, { gstin: '' }), true).error, /GSTIN is required/);
  const ok = auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  assert.equal(ok.ok, true); assert.equal(ok.owner.phone, 'XXXXXX3210');
  assert.equal(auth.setup(Object.assign({ phone: '9876543211', password: 'goodpw1' }, PROFILE), true).code, 409);
});
test('login lockout: 5th wrong try locks, exactly at lock end it opens again', () => {
  const { auth, clock } = authed({ OWNER_MAX_FAILS: '5', OWNER_LOCK_MIN: '15' });
  auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  for (let i = 1; i <= 4; i++) assert.equal(auth.login({ phone: '9876543210', password: 'bad' }).code, 401, 'try ' + i);
  assert.equal(auth.login({ phone: '9876543210', password: 'bad' }).code, 429);
  assert.equal(auth.login({ phone: '9876543210', password: 'goodpw1' }).code, 429, 'locked even with the right password');
  clock.t += 15 * 60e3 - 1;
  assert.equal(auth.login({ phone: '9876543210', password: 'goodpw1' }).code, 429);
  clock.t += 1;
  assert.equal(auth.login({ phone: '+91 98765 43210', password: 'goodpw1' }).ok, true);
});
test('login: unknown and invalid phones are 401, never 500', () => {
  const { auth } = authed();
  auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  assert.equal(auth.login({ phone: '9999999999', password: 'goodpw1' }).code, 401);
  assert.equal(auth.login({}).code, 401);
  assert.equal(auth.login({ phone: '9876543210', password: null }).code, 401);
});
test('sessions: valid until expiry, exactly at expiry gone; logout; oversized cookie ignored', () => {
  const { auth, clock } = authed({ SESSION_DAYS: '1' });
  const r = auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  const ck = cookie(r);
  assert.ok(auth.sessionOwner('a=b; ' + ck));
  assert.equal(auth.sessionOwner(''), null);
  assert.equal(auth.sessionOwner(auth.COOKIE + '=' + 'x'.repeat(201)), null);
  clock.t += 86400e3 - 1;
  assert.ok(auth.sessionOwner(ck));
  clock.t += 1;
  assert.equal(auth.sessionOwner(ck), null);
  const l = auth.login({ phone: '9876543210', password: 'goodpw1' });
  assert.ok(auth.sessionOwner(cookie(l)));
  auth.logout(cookie(l));
  assert.equal(auth.sessionOwner(cookie(l)), null);
  auth.logout(''); // no cookie: nothing
});
test('profile: switch to PAN needs a PAN; empty tax id keeps the saved one; masked output', () => {
  const { auth } = authed();
  auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  assert.match(auth.saveProfile(Object.assign({}, PROFILE, { gstRegistered: false, gstin: '' })).error, /PAN is required/);
  assert.match(auth.saveProfile(Object.assign({}, PROFILE, { gstRegistered: 'false', pan: 'BAD' })).error, /PAN must look like/);
  const keep = auth.saveProfile(Object.assign({}, PROFILE, { gstin: '' }));
  assert.equal(keep.ok, true); assert.equal(keep.profile.taxIdMasked, 'XXXXXXXXXXXF1ZV');
  const pan = auth.saveProfile(Object.assign({}, PROFILE, { gstRegistered: 0, pan: 'abcde1234f' }));
  assert.equal(pan.profile.taxKind, 'PAN'); assert.equal(pan.profile.taxIdMasked, 'XXXXXX234F');
  assert.equal(auth.taxId(), 'ABCDE1234F');
});
test('changePassword: wrong current, weak new, then works', () => {
  const { auth } = authed();
  auth.setup(Object.assign({ phone: '9876543210', password: 'goodpw1' }, PROFILE), true);
  const owner = auth.sessionOwner(cookie(auth.login({ phone: '9876543210', password: 'goodpw1' })));
  assert.equal(auth.changePassword(owner, { current: 'nope', password: 'newpw12' }).code, 401);
  assert.equal(auth.changePassword(owner, { current: 'goodpw1', password: '222222' }).code, 400);
  assert.equal(auth.changePassword(owner, { current: 'goodpw1', password: 'newpw12' }).ok, true);
  assert.equal(auth.login({ phone: '9876543210', password: 'newpw12' }).ok, true);
});

// ---------------------------------------------------------------- LLM chain + brain fallback
test('extractJson: fences, prose, trailing commas, braces inside strings, none', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sure! {"a":[1,2,],} ok'), { a: [1, 2] });
  assert.deepEqual(extractJson('{"s":"}{\\""}'), { s: '}{"' });
  assert.deepEqual(extractJson('{bad} then {"b":2}'), { b: 2 });
  assert.throws(() => extractJson(''), /no JSON/);
  assert.throws(() => extractJson(null), /no JSON/);
});
const reply = (content, status) => async () => ({ ok: !status, status: status || 200, json: async () => ({ choices: [{ message: { content } }] }) });
test('llm: no provider throws; HTTP failure falls to the next; invalid JSON does not trip the breaker', async () => {
  await assert.rejects(createLlm({ env: {} }).chatJson([]), /no LLM/);
  let n = 0;
  const env = { LLM_BASE_URL: 'http://a/v1/', AGENT37_LLM_PROXY_URL: 'http://b' };
  const llm = createLlm({ env, fetch: async (url) => { n++; return url.startsWith('http://a') ? reply('', 500)() : reply('{"x":1}')(); } });
  const r = await llm.chatJson([{ role: 'user', content: 'hi' }]);
  assert.equal(r.provider, 'router'); assert.equal(n, 2);
  const bad = createLlm({ env: { LLM_BASE_URL: 'http://a' }, fetch: reply('no json here') });
  for (let i = 0; i < 3; i++) await assert.rejects(bad.chatJson([]));
  assert.equal(bad.health().providers.custom.skipped, false, 'a live endpoint with bad JSON is not skipped');
});
test('llm circuit breaker: two failures skip the provider for the cooldown, then it is tried again', async () => {
  let calls = 0;
  const llm = createLlm({ env: { LLM_BASE_URL: 'http://a', LLM_COOLDOWN_MS: '50' }, fetch: async () => { calls++; throw new Error('down'); } });
  await assert.rejects(llm.chatJson([]));
  await assert.rejects(llm.chatJson([]));
  assert.equal(llm.health().providers.custom.skipped, true);
  await assert.rejects(llm.chatJson([]), /LLM failed/);
  assert.equal(calls, 2, 'skipped while cooling down');
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(llm.chatJson([]));
  assert.equal(calls, 3);
  assert.equal(llm.stats.lastProvider, 'rules');
});
test('brain: rules decide with no model, when the model fails, for open asks and for customers in the prefilter', async () => {
  const { s, c } = owing60();
  const off = createBrain({ env: {}, getState: () => s });
  assert.equal((await off.understandOwner('sarthak 20 udhaar')).parser, 'rules');
  assert.equal(await off.understandCustomer('kitna baaki', c.id), null);
  const failing = createBrain({ env: { LLM_BASE_URL: 'http://a' }, fetch: async () => { throw new Error('down'); }, getState: () => s });
  assert.equal((await failing.understandOwner('sarthak 20 udhaar')).parser, 'rules');
  assert.equal(await failing.understandCustomer('kitna baaki', c.id), null);
  let called = 0;
  const counting = createBrain({ env: { LLM_BASE_URL: 'http://a' }, fetch: async () => { called++; throw new Error('x'); }, getState: () => s });
  assert.equal(await counting.understandCustomer('🙏🙏', c.id), null);
  assert.equal(await counting.understandCustomer('hi', 'C-nope'), null);
  c.removed = true;
  assert.equal(await counting.understandCustomer('hi', c.id), null);
  assert.equal(called, 0, 'no model call for prefiltered, unknown or removed customers');
  assert.equal(await counting.translate('Namaste', 'hinglish'), null);
});
