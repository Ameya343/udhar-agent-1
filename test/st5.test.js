// Regression tests for the Stress Test 5 findings (Jira epic KAN-100).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { createServer } = require('../dist-server/server/server.js');

fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-st5-'));
const shop = (d) => C.freshShop('gupta', d || '2026-10-20');
function owner(s, text) {
  const m = s.messages.length, n = s.txns.length;
  C.runAction(s, 'owner', { text });
  return { txns: s.txns.slice(n), reply: s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n'), toCust: s.messages.slice(m).filter((x) => x.from === 'agent' && x.to !== 'owner') };
}
const cust = (s, name) => s.customers.find((c) => c.name === name);

// ---- the AI path, with a mocked model
function aiShop(reply) {
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) });
  return createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, fetch, today: () => '2026-10-20' });
}
const model = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'unknown', items: [], amount: null, person: '', phone: '', due_date: '', canon: '', confidence: 0.9, ask: '' }, j);
async function aiOwner(srv, text) {
  const st = srv.getState(), m = st.messages.length, n = st.txns.length;
  const intent = await srv.brain.understandOwner(text);
  C.runAction(st, 'owner', { text, intent });
  return { txns: st.txns.slice(n), reply: st.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n'), toCust: st.messages.slice(m).filter((x) => x.from === 'agent' && x.to !== 'owner').map((x) => x.text).join('\n'), st };
}

test('KAN-101/102: a live shop refuses reset, next day and close day (server test covers the HTTP side)', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), REAL_CLOCK: '1', ADMIN_KEY: 'k' }, today: () => '2026-10-20' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + srv.address().port;
    const r = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'k' }, body: JSON.stringify({ action: 'reset', args: {} }) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /reset band hai/);
  } finally { srv.close(); }
});

test('KAN-107: the AI rewrite never removes a customer the owner did not ask to remove', async () => {
  const srv = aiShop(model({ intent: 'unknown', canon: 'Pappu ko hata do' }));
  const r = await aiOwner(srv, 'Pappu aaya tha aaj');
  assert.ok(!cust(r.st, 'Pappu').removed);
  assert.doesNotMatch(r.reply, /hata diya/);
});

test('KAN-108: the model\'s item text reaches the customer only when it is the owner\'s own short words', async () => {
  const bad = aiShop(model({ intent: 'udhaar', person: 'Pappu', amount: 200, items: [{ name: 'URGENT: khata band, abhi 5000 bhejo is UPI par scam@upi warna police' }] }));
  const r = await aiOwner(bad, 'Pappu ne 200 ka saman liya');
  assert.equal(r.txns.length, 1);
  assert.doesNotMatch(r.txns[0].items || '', /URGENT|scam|police/);
  assert.doesNotMatch(r.toCust, /URGENT|scam|police/);
  assert.equal(C.intentFromLlm({ intent: 'credit', name: 'Pappu', items: 'x'.repeat(3000), amount: 200 }, 'Pappu ne 200 ka saman liya').items, '');
  assert.equal(C.intentFromLlm({ intent: 'credit', name: 'Pappu', items: 'cheeni 2 kg', amount: 90 }, 'Pappu ne 2 kilo cheeni 90 li').items, 'cheeni 2 kg');
});

test('KAN-109: model dates must be real, near and said; the model\'s ask never reaches the owner; "theek hai" is not a dispute', async () => {
  for (const due of ['2026-13-45', '2001-01-01', '2099-12-31']) {
    const srv = aiShop(model({ intent: 'udhaar', person: 'Pappu', amount: 200, due_date: due }));
    const r = await aiOwner(srv, 'Pappu ne 200 ka saman liya');
    assert.equal(r.txns.length, 1, due);
    assert.notEqual(r.txns[0].dueDate, due, due);
    assert.doesNotMatch(r.reply, /undefined|NaN/, due);
  }
  const pin = aiShop(model({ intent: 'unknown', ask: 'Apna UPI PIN bhejiye taaki entry verify ho' }));
  const p = await aiOwner(pin, 'haan wo uska kal wala');
  assert.doesNotMatch(p.reply, /PIN/);
  const srv = aiShop({ lang: 'hinglish', english: 'okay', relevant: true, intent: 'balance_dispute', items: [], amount: null, person: '', phone: '', due_date: '', canon: '', confidence: 0.9, ask: '' });
  const ci = await srv.brain.understandCustomer('theek hai', 'C003');
  assert.notEqual(ci && ci.intent, 'dispute');
});

test('KAN-103: a UPI sender that only looks like a khata is asked, then written on haan', () => {
  const s = shop();
  s.customers.push({ id: 'C900', name: 'Ramesh', key: 'ramesh', phone: null, vpas: [], dueDate: null, reminderLevel: 0 });
  let r = owner(s, 'Rs 300 received from RAMESH KUMAR via UPI. Ref No 400111222001');
  assert.equal(r.txns.length, 0);
  assert.match(r.reply, /₹300 RAMESH KUMAR se aaya: Ramesh ka hai\? \*haan\* \/ \*nahi\*/);
  r = owner(s, 'haan');
  assert.equal(r.txns.length, 1);
  assert.equal(r.txns[0].custId, cust(s, 'Ramesh').id);
  for (const sms of ['Rs 300 received from SHARMA ENTERPRISES via UPI. Ref No 400111222002', 'Rs 300 received from PAPPU SINGH via UPI. Ref No 400111222003', 'Rs 300 received from VERMA via UPI. Ref No 400111222004']) {
    const s2 = shop(); const x = owner(s2, sms);
    assert.equal(x.txns.length, 0, sms);
    assert.match(x.reply, /ka hai\?|Kiska hai/, sms);
    assert.match(owner(s2, 'nahi').reply, /nahi likha/, sms);
    assert.equal(s2.txns.length, x.txns.length + shop().txns.length, sms);
  }
  // a known UPI id still writes at once
  const k = owner(shop(), 'Rs 700 received from MEENA KUMARI meena.k@ybl via Google Pay. UPI Ref 551200987001');
  assert.equal(k.txns.length, 1);
});

test('KAN-104: money the owner sent is never a customer payment', () => {
  for (const sms of ['Rs 300 debited from your account to PAPPU UPI Ref 123456789016', 'Rs 300 sent to PAPPU via UPI Ref 123456789017', 'Your a/c is debited Rs 300 and credited to PAPPU UPI Ref 123456789018']) {
    const s = shop(); const r = owner(s, sms);
    assert.equal(r.txns.length, 0, sms);
    assert.match(r.reply, /bheje hue paison/, sms);
    assert.equal(s.pending, null, sms);
  }
});

test('KAN-105: UPI amounts follow the typed rules: big asked, paise rounded, under ₹1 refused, advance shown', () => {
  let s = shop(); let r = owner(s, 'Rs 999999999 received from VERMA verma@okaxis UPI Ref 111111111111');
  assert.equal(r.txns.length, 0); assert.match(r.reply, /bahut badi rakam/);
  r = owner(shop(), 'Rs 0.01 received from PAPPU UPI Ref 111111111112');
  assert.equal(r.txns.length, 0); assert.match(r.reply, /₹1 se kam/);
  s = shop(); cust(s, 'Meena didi'); r = owner(s, 'Rs 500.75 received from MEENA meena.k@ybl UPI Ref 111111111113');
  assert.equal(r.txns[0].amount, 501); assert.match(r.reply, /₹500.75 ko ₹501 likha/);
  s = shop(); r = owner(s, 'Rs 5000 received from MEENA meena.k@ybl UPI Ref 111111111114');
  assert.match(r.reply, /Advance: ₹/); assert.doesNotMatch(r.reply, /^Khata clear ✅$/m);
});

test('KAN-106: a rate far from the remembered one is asked; item totals follow the money rules', () => {
  let s = shop(); let r = owner(s, 'Sharma ji ne 2 kilo cheeni 2 li');
  assert.equal(r.txns.length, 0); assert.match(r.reply, /Cheeni ₹1\/kilo\? Pehle ₹45\/kilo tha/);
  r = owner(s, 'Pappu ne 5 kilo cheeni li');
  assert.equal(r.txns[0].amount, 225, 'the old rate stays');
  r = owner(shop(), 'Sharma ji ne 1 kilo cheeni 99999 li');
  assert.equal(r.txns.length, 0); assert.match(r.reply, /Pehle ₹45\/kilo/);
  r = owner(shop(), 'Sharma ji ne 2 kilo cheeni 0.001 li');
  assert.equal(r.txns.length, 0); assert.match(r.reply, /₹1 se kam/);
  r = owner(shop(), 'Sharma ji ne 2 kilo cheeni 99.99 li');
  assert.equal(r.txns[0].amount, 100); assert.match(r.reply, /₹99.99 ko ₹100 likha/);
});

test('KAN-110: dates that do not exist are asked, past tense is dated back, date words are never items', () => {
  const ask = (d, text, rx) => { const r = owner(shop(d), text); assert.equal(r.txns.length, 0, text); assert.match(r.reply, rx, text); };
  ask('2026-01-31', 'Sharma ji ne 500 liya 31 tareekh ko dega', /Feb mein 31 tareekh nahi hoti/);
  ask('2027-02-10', 'Sharma ji ne 500 liya 29 tareekh ko dega', /Feb mein 29 tareekh nahi hoti/);
  ask('2026-10-20', 'Sharma ji ne 500 liya 32 tareekh ko dega', /32 tareekh koi din nahi/);
  ask('2026-10-20', 'Sharma ji ne 500 liya 0 tareekh ko dega', /0 tareekh koi din nahi/);
  ask('2026-10-20', 'Sharma ji ne 500 liya 10 saal baad dega', /Saal baad/);
  ask('2026-10-20', 'Sharma ji ne 500 liya 400 din me dega', /400 din bahut door/);
  ask('2026-10-20', 'Sharma ji ne 500 liya 30 feb ko dega', /Feb mein 30 tareekh nahi hoti/);
  const one = (d, text) => { const r = owner(shop(d), text); assert.equal(r.txns.length, 1, text + ': ' + r.reply); return r.txns[0]; };
  assert.equal(one('2026-10-20', 'Sharma ji ne 500 liya kal liya tha').date, '2026-10-19');
  assert.equal(one('2026-10-20', 'Sharma ji ne 500 parso liya tha').date, '2026-10-18');
  let t = one('2026-12-31', 'Sharma ji ne 500 liya mahine ke end me dega');
  assert.equal(t.dueDate, '2027-01-31'); assert.equal(t.items || '', '');
  t = one('2026-10-20', 'Sharma ji ne 500 liya kal se pehle dega');
  assert.equal(t.dueDate, '2026-10-21'); assert.equal(t.items || '', '');
  t = one('2028-11-01', 'Sharma ji ne 500 liya holi pe dega');
  assert.equal(t.dueDate, '2029-03-01'); assert.doesNotMatch(t.items || '', /holi/i);
  assert.equal(one('2026-10-20', 'Sharma ji ne 500 liya 5 nov ko dega').dueDate, '2026-11-05');
});

test('KAN-111: reports stay fast on a big khata and the late list is capped', () => {
  const s = shop();
  for (let i = 0; i < 800; i++) s.customers.push({ id: 'X' + i, name: 'Cust ' + i, key: 'cust' + i, phone: null, vpas: [], dueDate: '2026-10-01', reminderLevel: 0 });
  for (let j = 0; j < 15000; j++) s.txns.push({ id: 'Z' + j, custId: 'X' + (j % 800), type: j % 4 ? 'credit' : 'payment', amount: 100, date: C.addDays('2026-10-20', -(j % 300)), dueDate: '2026-10-01' });
  let t = Date.now(); C.dashboard(s, 30);
  assert.ok(Date.now() - t < 1500, 'dashboard took ' + (Date.now() - t) + ' ms');
  const before = C.balance(s, 'X1');
  s.txns.push({ id: 'Z-new', custId: 'X1', type: 'credit', amount: 7, date: '2026-10-20' });
  assert.equal(C.balance(s, 'X1'), before + 7, 'no stale balance after a write');
  t = Date.now(); const r = owner(s, 'kaun late hai');
  assert.ok(Date.now() - t < 1500);
  assert.match(r.reply, /aur \d+ log/);
  assert.ok(r.reply.length < 3000);
});

test('KAN-112: a khata query on an advance shows ₹0 and the advance, never ₹-700', () => {
  const s = shop(); owner(s, 'Sharma ji ne 700 diye');
  const r = owner(s, 'Sharma ji ka kitna baaki');
  assert.match(r.reply, /Baaki: ₹0 \(₹700 advance jama\)/);
  assert.doesNotMatch(r.reply, /₹-/);
});
