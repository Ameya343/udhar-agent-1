// Soft remove of a customer: "<Name> ko hatao" / "<Name> ko wapas lao". Money records stay; the customer drops out
// of lists, reminders and sends. "hatao" on its own is still the undo of the last entry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { createServer } = require('../dist-server/server/server.js');
const { fakeWeb } = require('./fake-wa.js');

const TODAY = '2026-10-07';
const shop = () => C.freshShop('gupta', TODAY);
const owner = (s, t) => C.handleOwnerMessage(s, t).messages.filter((m) => m.to === 'owner').map((m) => m.text).join('\n');
const byName = (s, n) => s.customers.find((c) => c.name === n);

test('remove phrasings resolve to the customer; plain "hatao" and "galti hatao" stay undo', () => {
  const s = shop();
  for (const t of ['Pappu ko hatao', 'Pappu ko remove karo', 'pappu ko delete karo', 'Pappu ko block karo', 'पप्पू को हटाओ']) {
    const i = C.removeIntent(s, t);
    assert.ok(i, t); assert.strictEqual(i.intent, 'remove_customer', t); assert.deepStrictEqual(i.matches.map((c) => c.name), ['Pappu'], t);
  }
  assert.strictEqual(C.removeIntent(s, 'Pappu ko wapas lao').intent, 'restore_customer');
  for (const t of ['hatao', 'galti hatao', 'galti ko hatao', 'last wala hatao', 'Zorawar ko hatao']) assert.strictEqual(C.removeIntent(s, t), null, t);
  assert.strictEqual(C.parseOwnerMessage('hatao', TODAY).intent, 'undo');
  assert.strictEqual(C.parseOwnerMessage('galti hatao', TODAY).intent, 'undo');
});

test('undo regression: "hatao" after an entry voids it and removes nobody', () => {
  const s = shop();
  owner(s, 'Pappu ne 50 ka saaman liya');
  const before = C.balance(s, byName(s, 'Pappu').id);
  const r = owner(s, 'hatao');
  assert.match(r, /↩️ Hata diya: Pappu ka ₹50 udhaar/);
  assert.strictEqual(C.balance(s, byName(s, 'Pappu').id), before - 50);
  assert.ok(!s.customers.some((c) => c.removed));
  owner(s, 'Pappu ne 30 ka saaman liya');
  assert.match(owner(s, 'galti hatao'), /↩️ Hata diya: Pappu ka ₹30/);
  assert.ok(!byName(s, 'Pappu').removed);
});

test('remove keeps the money, shows the baaki, and restore brings the customer back unchanged', () => {
  const s = shop();
  const p = byName(s, 'Pappu'), bal = Math.round(C.balance(s, p.id));
  assert.ok(bal > 0);
  const snap = JSON.stringify(p), txns = s.txns.length, total = C.totalOutstanding(s);
  const r = owner(s, 'Pappu ko hatao');
  assert.strictEqual(r.split('\n')[0], '✅ Pappu ko hata diya. Purana hisaab (baaki ' + C.rupees(bal) + ') record mein rahega. Wapas laane ke liye: Pappu ko wapas lao');
  assert.strictEqual(p.removed, true); assert.ok(p.removedAt);
  assert.strictEqual(s.txns.length, txns); assert.strictEqual(C.totalOutstanding(s), total); // history totals stay honest
  assert.match(owner(s, 'Pappu ko hatao'), /pehle se hataye gaye/);
  assert.match(owner(s, 'Pappu ko wapas lao'), /♻️ Pappu wapas aa gaye/);
  assert.strictEqual(JSON.stringify(p), snap);
});

test('two customers with the same name: the owner is asked which one', () => {
  const s = shop();
  owner(s, 'Rahul Kumar ne 100 ka saaman liya');
  owner(s, 'haan');
  owner(s, 'Amit Kumar ne 50 ka saaman liya');
  owner(s, 'haan');
  const r = owner(s, 'Kumar ko hatao');
  assert.match(r, /naam ke \d khate hain. Kaun se\?/);
  assert.ok(s.pending);
  const r2 = owner(s, '1');
  assert.match(r2, /✅ .* ko hata diya/);
  assert.strictEqual(s.customers.filter((c) => c.removed).length, 1);
});

test('a removed customer leaves the lists, reminders, summary and new udhaar', () => {
  const s = shop();
  const p = byName(s, 'Pappu');
  p.dueDate = TODAY; // would get a reminder today
  owner(s, 'Pappu ko hatao');
  assert.doesNotMatch(owner(s, 'kaun kaun baaki hai'), /Pappu/);
  assert.doesNotMatch(owner(s, 'aaj ka hisaab'), /Sabse zyada:[^\n]*Pappu/);
  assert.ok(!C.todayStats(s).top.some((x) => x.name === 'Pappu'));
  assert.ok(!C.dashboard(s, 30).overdue.some((x) => x.name === 'Pappu'));
  assert.ok(!C.runMorningJobs(s).some((m) => m.to === p.id));
  assert.doesNotMatch(C.runEveningSummary(s).map((m) => m.text).join('\n'), /Late:[^\n]*Pappu/);
  const before = s.txns.length;
  assert.match(owner(s, 'Pappu ne 100 ka saaman liya'), /Pappu hataye gaye hain, pehle wapas lao/);
  assert.strictEqual(s.txns.length, before);
  assert.match(owner(s, 'Pappu ko yaad dila do'), /hataye gaye hain/);
  owner(s, 'Pappu ko wapas lao');
  assert.match(owner(s, 'Pappu ne 100 ka saaman liya'), /✅ Likh liya: Pappu/);
});

test('dashboard actions removeCustomer / restoreCustomer', () => {
  const s = shop();
  const msgs = s.messages.length;
  const r = C.runAction(s, 'removeCustomer', { custId: 'C003' }).result;
  assert.ok(r.ok); assert.match(r.text, /hata diya/);
  assert.strictEqual(s.customers.find((c) => c.id === 'C003').removed, true);
  assert.strictEqual(s.messages.length, msgs); // the owner's chat is left alone
  assert.ok(C.runAction(s, 'restoreCustomer', { custId: 'C003' }).result.ok);
  assert.ok(!s.customers.find((c) => c.id === 'C003').removed);
  assert.throws(() => C.runAction(s, 'removeCustomer', { custId: 'nope' }), /unknown customer/);
});

// ---- WhatsApp: no sends to a removed customer, one polite line at most, no "Naya number" ask
const PUBLIC = 'https://gupta.example.org', OWNER = '+919800000001', SHARMA = '+919876500001';
function fakeFetch() {
  const sent = [];
  const f = async (url, init) => {
    url = String(url);
    return new Response('{}', { status: 404 });
  };
  f.sent = sent;
  f.to = (n) => sent.filter((x) => x.to === 'whatsapp:' + n).map((x) => x.body);
  f.clear = () => { sent.length = 0; };
  return f;
}
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

test('WhatsApp: recipient blocked, one polite line, no new-number ask, restore works', async () => {
  const fetch = fakeFetch();
  const env = { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-rm-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC };
  const web = fakeWeb((to, c) => fetch.sent.push({ to: 'whatsapp:+' + to, body: c.text }));
  const server = createServer({ env, today: () => TODAY, fetch, webTransport: web.factory });
  await listen(server);
  const inbound = (fromNum, body) => web.inbound(server, { From: fromNum, ProfileName: 'Sharma', Body: body });
  try {
    await inbound(SHARMA, 'hi'); // known number joins (c.wa)
    fetch.clear();
    await inbound(OWNER, 'Sharma ji ko hatao');
    assert.match(fetch.to(OWNER).join('\n'), /✅ Sharma ji ko hata diya/);
    fetch.clear();
    await inbound(OWNER, 'Sharma ji ko yaad dila do');
    await inbound(OWNER, 'sabko reminder bhejo');
    assert.deepStrictEqual(fetch.to(SHARMA), []);
    await inbound(SHARMA, 'hi');
    await inbound(SHARMA, 'hello?');
    // never silent: every message gets a short line, and the owner is asked once whether to reopen the khata
    assert.deepStrictEqual(fetch.to(SHARMA), ['Namaste 🙏 Aapka message Gupta Kirana Store ko bhej diya hai. Dukaan jald jawab degi.', '🙏 Aapka message Gupta Kirana Store tak pahuncha diya hai.']);
    assert.match(fetch.to(OWNER).join('\n'), /Sharma ji \(hataye gaye\) ne likha: "hello\?"/);
    assert.doesNotMatch(fetch.to(OWNER).join('\n'), /Naya number/);
    assert.strictEqual(fetch.to(OWNER).filter((t) => /Sharma ji \(0001\) ne hi bheja\. Khata kholun\? \*ok\*/.test(t)).length, 1);
    fetch.clear();
    await inbound(OWNER, 'nahi');
    assert.match(fetch.to(OWNER).join('\n'), /hataye hue hi rahenge/);
    await inbound(SHARMA, 'hi');
    assert.deepStrictEqual(fetch.to(SHARMA), ['🙏 Aapka message Gupta Kirana Store tak pahuncha diya hai.'], 'declined today: not asked again, but still a reply');
    assert.doesNotMatch(fetch.to(OWNER).join('\n'), /Khata kholun/);
    fetch.clear();
    await inbound(OWNER, 'Sharma ji ko wapas lao');
    assert.match(fetch.to(OWNER).join('\n'), /♻️ Sharma ji wapas aa gaye/);
    await inbound(OWNER, 'Sharma ji ne 100 ka saaman liya');
    assert.ok(fetch.to(SHARMA).length >= 1);
  } finally { server.close(); }
});

test('WhatsApp: a removed number says hi, owner "ok" reopens the khata and the customer is told', async () => {
  const fetch = fakeFetch();
  const env = { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-rm-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC };
  const web = fakeWeb((to, c) => fetch.sent.push({ to: 'whatsapp:+' + to, body: c.text }));
  const server = createServer({ env, today: () => TODAY, fetch, webTransport: web.factory });
  await listen(server);
  const inbound = (fromNum, body) => web.inbound(server, { From: fromNum, ProfileName: 'Sharma', Body: body });
  try {
    await inbound(SHARMA, 'hi');
    await inbound(OWNER, 'Sharma ji ko hatao');
    fetch.clear();
    await inbound(SHARMA, 'Hi');
    assert.strictEqual(fetch.to(SHARMA).length, 1);
    assert.match(fetch.to(OWNER).join('\n'), /Sharma ji \(0001\) ne hi bheja\. Khata kholun\?/);
    fetch.clear();
    await inbound(OWNER, 'ok');
    assert.match(fetch.to(OWNER).join('\n'), /♻️ Sharma ji wapas aa gaye/);
    assert.match(fetch.to(SHARMA).join('\n'), /khata phir se khol diya/);
    fetch.clear();
    await inbound(SHARMA, 'hi');
    assert.ok(fetch.to(SHARMA).length >= 1, 'a known customer\'s hi is answered');
  } finally { server.close(); }
});

test('a known customer\'s second "hi" inside the menu half hour still gets a short line', () => {
  const s = shop();
  const c = s.customers[0]; c.wa = true;
  const t0 = Date.parse(TODAY + 'T10:00:00Z');
  const a = C.handleCustomerMessage(s, c.id, 'hello', { now: t0 });
  assert.strictEqual(a.filter((m) => m.to === c.id).length, 1);
  const b = C.handleCustomerMessage(s, c.id, 'Hi', { now: t0 + 60e3 * 5 });
  assert.match(b.filter((m) => m.to === c.id).map((m) => m.text).join('\n'), /Boliye, kya chahiye/);
});
