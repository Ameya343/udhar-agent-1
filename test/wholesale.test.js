// Ordering stock from wholesalers: each wholesaler has a number and the items they supply. The owner orders by text or
// voice, sees a draft, and on "ok" each wholesaler gets only their own items in their own order message. A wholesaler's
// reply goes to the owner (never into the customer flows), and a bill in it becomes a supplier-khata entry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../core/agent-core.js');
const { createServer } = require('../server/server.js');
const { twilioSignature } = require('../server/whatsapp.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

const ws = (st, name) => st.wholesalers.find((w) => w.name === name);
// the Gupta demo shop; `ready` gives numbers to the named wholesalers and marks them as having written to the shop
function shop(ready) {
  const st = C.freshShop('gupta', TODAY);
  (ready || []).forEach((name, i) => { const w = ws(st, name); w.phone = '98227000' + String(10 + i); w.wa = true; });
  return st;
}
function say(st, text, source) {
  const n = st.messages.length, before = st.txns.length, sup = (st.supplies || []).length;
  C.runAction(st, 'owner', { text, source: source || 'text' });
  const out = st.messages.slice(n).filter((m) => m.from === 'agent');
  return { owner: out.filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), toWs: out.filter((m) => /^W\d/.test(m.to)), other: out.filter((m) => m.to !== 'owner' && !/^W\d/.test(m.to)), txns: st.txns.slice(before), supplies: st.supplies.slice(sup) };
}
function fromWs(st, name, text) {
  const n = st.messages.length, before = st.txns.length;
  C.runAction(st, 'wholesaler', { wsId: ws(st, name).id, text });
  const out = st.messages.slice(n).filter((m) => m.from === 'agent');
  return { owner: out.filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), other: out.filter((m) => m.to !== 'owner'), txns: st.txns.slice(before) };
}

test('the demo shop has exactly 4 wholesalers, with items and no invented numbers', () => {
  const st = C.freshShop('gupta', TODAY);
  assert.deepEqual(st.wholesalers.map((w) => w.name), ['Agrawal Traders', 'Hindustan Agency', 'Modern Bakery', 'Shree Dairy']);
  assert.ok(st.wholesalers.every((w) => w.phone === null && w.items.length >= 4));
  assert.ok(ws(st, 'Modern Bakery').items.includes('bread'));
  assert.ok(ws(st, 'Shree Dairy').items.includes('doodh'));
  // the migration adds only what is missing and leaves everything else alone
  const old = C.freshShop('gupta', TODAY);
  old.wholesalers = [{ id: 'W001', key: 'agraval traders', name: 'Agrawal Traders', phone: '9822700099', items: ['aata'], wa: true }];
  const txns = JSON.stringify(old.txns), sup = JSON.stringify(old.supplies);
  assert.deepEqual(C.seedWholesalers(old, 'gupta'), ['Hindustan Agency', 'Modern Bakery', 'Shree Dairy']);
  assert.equal(old.wholesalers[0].phone, '9822700099'); assert.deepEqual(old.wholesalers[0].items, ['aata']);
  assert.equal(JSON.stringify(old.txns), txns); assert.equal(JSON.stringify(old.supplies), sup);
  assert.deepEqual(C.seedWholesalers(old, 'gupta'), []);
});

test('owner sets a number and who supplies what; a new wholesaler can be added by number', () => {
  const st = shop();
  let r = say(st, 'Agrawal traders ka number 9822700001');
  assert.equal(ws(st, 'Agrawal Traders').phone, '9822700001');
  assert.match(r.owner, /Agrawal Traders ka number save: \+91 9822700001/);
  assert.match(r.owner, /"hi" bhejne boliye/);
  assert.equal(st.customers.some((c) => c.phone === '9822700001'), false); // not a customer
  r = say(st, 'bread aur doodh Modern Dairy se aata hai');
  const md = ws(st, 'Modern Dairy');
  assert.ok(md, 'Modern Dairy added');
  assert.deepEqual(md.items, ['bread', 'doodh']);
  assert.ok(!ws(st, 'Modern Bakery').items.includes('bread'));
  assert.ok(!ws(st, 'Shree Dairy').items.includes('doodh'));
  assert.match(r.owner, /Bread, Doodh ab Modern Dairy se/);
  r = say(st, 'Gupta Distributors ka number 9822700005');
  assert.equal(ws(st, 'Gupta Distributors').phone, '9822700005');
  r = say(st, 'wholesaler list');
  assert.match(r.owner, /Agrawal Traders: \+91 9822700001/);
  assert.match(r.owner, /Hindustan Agency: number nahi/);
});

test('text order: draft first, then on ok Agrawal Traders gets the order in the wholesale template', () => {
  const st = shop(['Agrawal Traders']);
  let r = say(st, 'Agrawal traders ko order: 10 kilo cheeni, 5 kilo aata');
  assert.equal(r.toWs.length, 0, 'nothing goes before the owner says ok');
  assert.equal(r.owner, '🛒 Agrawal Traders ko bhejun?\n- Cheeni 10 kg\n- Aata 5 kg\nJawab: *ok* ya *cancel*');
  r = say(st, 'ok');
  assert.equal(r.toWs.length, 1);
  assert.equal(r.toWs[0].to, ws(st, 'Agrawal Traders').id);
  assert.equal(r.toWs[0].kind, 'ws-order');
  assert.equal(r.toWs[0].text, 'Gupta Kirana Store (Nagpur) ka order:\n- Cheeni 10 kg\n- Aata 5 kg\nKab tak bhej denge? Bill amount bhi bata dein.');
  assert.doesNotMatch(r.toWs[0].text, /udhaar|Sahi hai|haan|galat/i); // never the customer template
  assert.match(r.owner, /Order bheja: Agrawal Traders/);
  assert.equal(r.txns.length, 0); assert.equal(r.supplies.length, 0); // nothing in any khata yet
  assert.equal(st.wsOrders[0].status, 'sent');
});

test('cancel drops the draft; nothing is sent', () => {
  const st = shop(['Agrawal Traders']);
  say(st, 'Agrawal traders ko order: 10 kilo cheeni');
  const r = say(st, 'cancel');
  assert.equal(r.toWs.length, 0);
  assert.match(r.owner, /Order cancel/);
  assert.equal(st.wsOrders[0].status, 'cancelled');
});

test('routed by item: "bread 20 packet mangwa do" goes to Modern Bakery', () => {
  const st = shop(['Modern Bakery']);
  let r = say(st, 'bread 20 packet mangwa do');
  assert.match(r.owner, /^🛒 Modern Bakery ko bhejun\?\n- Bread 20 packet/);
  r = say(st, 'haan');
  assert.equal(r.toWs.length, 1);
  assert.match(r.toWs[0].text, /- Bread 20 packet/);
});

test('one order, several wholesalers: one draft listing each part, then a separate message to each with only their items', () => {
  const st = shop(['Agrawal Traders', 'Modern Bakery', 'Shree Dairy']);
  let r = say(st, 'cheeni 10 kilo, bread 20 packet, doodh 30 litre mangwa do');
  assert.equal(r.owner, '🛒 3 wholesaler ko alag alag order bhejun?\nAgrawal Traders:\n- Cheeni 10 kg\nModern Bakery:\n- Bread 20 packet\nShree Dairy:\n- Doodh 30 litre\nHar ek ko sirf unka saaman jayega. Jawab: *ok* ya *cancel*');
  r = say(st, 'ok');
  assert.equal(r.toWs.length, 3);
  const by = Object.fromEntries(r.toWs.map((m) => [st.wholesalers.find((w) => w.id === m.to).name, m.text]));
  assert.match(by['Agrawal Traders'], /- Cheeni 10 kg\nKab tak/); assert.doesNotMatch(by['Agrawal Traders'], /Bread|Doodh/);
  assert.match(by['Modern Bakery'], /- Bread 20 packet\nKab tak/); assert.doesNotMatch(by['Modern Bakery'], /Cheeni|Doodh/);
  assert.match(by['Shree Dairy'], /- Doodh 30 litre\nKab tak/); assert.doesNotMatch(by['Shree Dairy'], /Cheeni|Bread/);
  assert.match(r.owner, /Order bheja: Agrawal Traders, Modern Bakery, Shree Dairy/);
  assert.equal(st.wsOrders.length, 3);
  // a split where one wholesaler has no number: the others still get theirs, the owner is told
  const s2 = shop(['Agrawal Traders']);
  r = say(s2, 'cheeni 10 kilo, bread 20 packet mangwa do');
  assert.match(r.owner, /Modern Bakery ka number nahi hai/);
  assert.match(r.owner, /🛒 Agrawal Traders ko bhejun\?\n- Cheeni 10 kg/);
  r = say(s2, 'ok');
  assert.equal(r.toWs.length, 1); assert.doesNotMatch(r.toWs[0].text, /Bread/);
});

test('unmapped item: the agent asks "kis wholesaler se mangwaun?" and the answer makes the draft', () => {
  const st = shop(['Agrawal Traders']);
  let r = say(st, 'kaju 2 kilo mangwa do');
  assert.match(r.owner, /Kaju: kis wholesaler se mangwaun\?/);
  assert.equal((st.wsOrders || []).length, 0);
  r = say(st, 'Agrawal traders');
  assert.match(r.owner, /🛒 Agrawal Traders ko bhejun\?\n- Kaju 2 kg/);
  r = say(st, 'ok');
  assert.equal(r.toWs.length, 1);
});

test('no number: the owner is told, no draft and nothing sent', () => {
  const st = shop();
  const r = say(st, 'Agrawal traders ko order: 10 kilo cheeni, 5 kilo aata');
  assert.match(r.owner, /Agrawal Traders ka number nahi hai/);
  assert.equal(r.toWs.length, 0);
  assert.equal((st.ownerAsks || []).length, 0);
});

test('a wholesaler who never wrote to the shop: the order is not sent and the owner learns why', () => {
  const st = shop();
  ws(st, 'Agrawal Traders').phone = '9822700001'; // number set, but they never sent "hi"
  say(st, 'Agrawal traders ko order: 10 kilo cheeni');
  const r = say(st, 'ok');
  assert.equal(r.toWs.length, 0);
  assert.match(r.owner, /Agrawal Traders ko order WhatsApp par nahi gaya: unhone abhi tak dukaan ke number par "hi" nahi bheja/);
  assert.match(r.owner, /- Cheeni 10 kg/); // so the owner can tell them on the phone
  assert.equal(st.wsOrders[0].status, 'unsent');
});

test('wholesaler reply with a bill: forwarded short, owner ok writes the supplier udhaar linked to the order', () => {
  const st = shop(['Agrawal Traders']);
  say(st, 'Agrawal traders ko order: 10 kilo cheeni, 5 kilo aata'); say(st, 'ok');
  let r = fromWs(st, 'Agrawal Traders', 'kal subah bhej denge, bill 1,850');
  assert.match(r.owner, /^📦 Agrawal Traders: kal subah bhej denge, bill 1,850/);
  assert.match(r.owner, /Maal aane par Agrawal Traders ka ₹1,850 udhaar likhun\? \*ok\* ya \*nahi\*/);
  assert.equal(r.other.length, 0); assert.equal(r.txns.length, 0); // nothing to the wholesaler, nothing in the customer khata
  // the owner's view of what they owe includes the open order
  r = say(st, 'kisko kitna dena hai');
  assert.match(r.owner, /Maal aana baaki:\n {2}• Agrawal Traders \(8 Oct\): Cheeni 10 kg, Aata 5 kg, bill ₹1,850/);
  r = say(st, 'ok');
  assert.equal(r.supplies.length, 1);
  const k = r.supplies[0];
  assert.equal(k.name, 'Agrawal Traders'); assert.equal(k.amount, 1850); assert.equal(k.paid, 0); assert.equal(k.orderId, st.wsOrders[0].id);
  assert.equal(st.wsOrders[0].status, 'delivered'); assert.equal(st.wsOrders[0].supplyId, k.id);
  assert.match(r.owner, /Agrawal Traders ka maal aa gaya: ₹1,850 udhaar likh diya/);
  assert.equal(r.txns.length, 0);
  const d = C.dashboard(st).wholesalers.find((w) => w.name === 'Agrawal Traders');
  assert.equal(d.owed, 14000 + 1850); assert.equal(d.openOrders.length, 0);
});

test('"maal aa gaya, 1850 cash de diya": the order is written as bought and paid', () => {
  const st = shop(['Agrawal Traders']);
  say(st, 'Agrawal traders ko order: 10 kilo cheeni'); say(st, 'ok');
  fromWs(st, 'Agrawal Traders', 'shaam tak aa jayega');
  const d0 = C.dashboard(st).wholesalers.find((w) => w.name === 'Agrawal Traders');
  assert.equal(d0.openOrders.length, 1); assert.equal(d0.phone, '9822700010');
  const r = say(st, 'maal aa gaya, 1850 cash de diya');
  assert.equal(r.supplies.length, 1);
  assert.equal(r.supplies[0].amount, 1850); assert.equal(r.supplies[0].paid, 1850);
  assert.match(r.owner, /Agrawal Traders ka maal aa gaya, ₹1,850 cash diye/);
  assert.equal(C.dashboard(st).wholesalers.find((w) => w.name === 'Agrawal Traders').owed, 14000);
  // "maal aa gaya" with no amount and no bill asks for it
  const s2 = shop(['Modern Bakery']);
  say(s2, 'bread 20 packet mangwa do'); say(s2, 'ok');
  assert.match(say(s2, 'maal aa gaya').owner, /Modern Bakery ka bill kitne ka hai\?/);
});

test('the supplier khata and customer flows are unchanged by all this', () => {
  const st = shop(['Agrawal Traders']);
  let r = say(st, 'Agrawal traders se 5000 ka maal udhaar, 20 tareekh tak');
  assert.match(r.owner, /Likh liya: Agrawal Traders ka ₹5,000 maal udhaar/);
  r = say(st, 'Agrawal traders ko 3000 de diye');
  assert.match(r.owner, /Agrawal Traders ko ₹3,000 diye/);
  r = say(st, 'Sharma ji ne 340 ka saaman liya');
  assert.equal(r.txns.length, 1); assert.equal(r.txns[0].amount, 340);
  r = say(st, 'Pappu ne 200 jama kiye');
  assert.equal(r.txns[0].type, 'payment');
  // a customer's own order still goes the customer way
  const n = st.messages.length;
  C.runAction(st, 'customer', { custId: 'C002', text: 'aata 5 kilo, maggi 4' });
  assert.ok(st.messages.slice(n).some((m) => m.to === 'C002' && /Order mila/.test(m.text)));
  assert.equal((st.wsOrders || []).length, 0);
});

// ---------------------------------------------------------------- over WhatsApp (Twilio fake), text and voice
const PUBLIC = 'https://gupta.example.org', OWNER = '+919800000001', AGRAWAL = '+919822700001', STRANGER = '+919822799999';
function fakeFetch(heard) {
  const sent = [];
  const f = async (url, init) => {
    url = String(url);
    if (url.includes('/Messages.json')) { const p = new URLSearchParams(init.body); sent.push({ to: p.get('To'), body: p.get('Body') }); return new Response('{}', { status: 201 }); }
    if (url.includes('/Media/')) return new Response(Buffer.from('OggS fake audio'), { status: 200 });
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: heard || '' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  f.to = (num) => sent.filter((s) => s.to === 'whatsapp:' + num).map((s) => s.body);
  f.clear = () => { sent.length = 0; };
  return f;
}
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
async function inbound(base, server, fields) {
  const params = Object.assign({ MessageSid: 'SM' + Math.random().toString(16).slice(2), NumMedia: '0' }, fields);
  await fetch(base + '/whatsapp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('secret-token', PUBLIC + '/whatsapp', params) }, body: new URLSearchParams(params).toString() });
  await server.idle();
}
function waServer(heard) {
  const fetch = fakeFetch(heard);
  const env = { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-ws-')), TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886', OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC, STT_URL: 'https://stt.example.org/v1' };
  return { server: createServer({ env, today: () => TODAY, fetch }), fetch };
}

test('WhatsApp: number set, wholesaler says hi (not a guest), voice order, ok sends it, reply with bill reaches the owner', async () => {
  const { server, fetch: tw } = waServer('Agrawal traders ko order bhejo das kilo cheeni paanch kilo aata');
  const base = await listen(server);
  try {
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'Agrawal traders ka number 9822700001' });
    assert.match(tw.to(OWNER).join('\n'), /Agrawal Traders ka number save/);
    tw.clear();
    // before they ever wrote: the order is not sent, the owner is told why
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'Agrawal traders ko order: 2 kilo dal' });
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'ok' });
    assert.equal(tw.to(AGRAWAL).length, 0);
    assert.match(tw.to(OWNER).join('\n'), /nahi gaya: unhone abhi tak dukaan ke number par "hi" nahi bheja/);
    tw.clear();
    // their "hi" is a wholesaler's message: shown to the owner, no guest khata, no customer welcome
    const customers = server.getState().customers.length;
    await inbound(base, server, { From: 'whatsapp:' + AGRAWAL, ProfileName: 'Agrawal', Body: 'hi' });
    assert.equal(server.getState().customers.length, customers);
    assert.match(tw.to(OWNER).join('\n'), /📦 Agrawal Traders ne hi bheja, ab order bhej sakte hain\./);
    assert.deepEqual(tw.to(AGRAWAL), ['Namaste 🙏 Gupta Kirana Store ka order isi number par aayega. Bill aur kab tak bhejenge, yahin bata dijiye.']); // a short business line, not the customer menu
    tw.clear();
    // a voice note from the owner
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: '', NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1' });
    assert.match(tw.to(OWNER).join('\n'), /🛒 Agrawal Traders ko bhejun\?\n- Cheeni 10 kg\n- Aata 5 kg/);
    assert.equal(tw.to(AGRAWAL).length, 0);
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'ok' });
    assert.deepEqual(tw.to(AGRAWAL), ['Gupta Kirana Store (Nagpur) ka order:\n- Cheeni 10 kg\n- Aata 5 kg\nKab tak bhej denge? Bill amount bhi bata dein.']);
    tw.clear();
    await inbound(base, server, { From: 'whatsapp:' + AGRAWAL, Body: 'kal subah bhej denge, bill 1850' });
    const o = tw.to(OWNER).join('\n');
    assert.match(o, /📦 Agrawal Traders: kal subah bhej denge, bill 1850/);
    assert.match(o, /Maal aane par Agrawal Traders ka ₹1,850 udhaar likhun\?/);
    assert.equal(tw.to(AGRAWAL).length, 0); // never the customer menu or "Sahi hai?"
    tw.clear();
    await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'maal aa gaya' });
    assert.match(tw.to(OWNER).join('\n'), /Agrawal Traders ka maal aa gaya: ₹1,850 udhaar likh diya/);
    const st = server.getState();
    assert.equal(st.supplies[st.supplies.length - 1].amount, 1850);
    // a stranger is still a guest customer as before
    await inbound(base, server, { From: 'whatsapp:' + STRANGER, ProfileName: 'Ravi', Body: 'hi' });
    assert.ok(server.getState().customers.find((c) => c.phone === '9822799999' && c.guest));
  } finally { server.close(); }
});

test('AI prompt knows wholesale; its clean rewrite (canon) feeds the same rule parser', () => {
  const st = shop(['Agrawal Traders']);
  const p = C.llmRequestParts('agarwal wale ko bolo das kilo chini bhejo', st);
  assert.ok(p.schema.properties.intent.enum.includes('wholesale'));
  assert.match(p.system, /wholesale = the owner orders STOCK/);
  assert.match(p.system, /Modern Bakery \(bread, pav, biscuit, rusk\)/);
  const intent = C.intentFromLlm({ intent: 'wholesale', name: 'Agrawal Traders', items: '10 kilo cheeni', amount: 0, due_date: '', phone: '', canon: 'Agrawal Traders ko order: 10 kilo cheeni', ask: '' }, 'agarwal wale ko bolo das kilo chini bhejo');
  assert.equal(intent.intent, 'unknown');
  const n = st.messages.length;
  C.runAction(st, 'owner', { text: 'agarwal wale ko bolo das kilo chini bhejo', source: 'voice', intent });
  assert.match(st.messages.slice(n).filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), /🛒 Agrawal Traders ko bhejun\?\n- Cheeni 10 kg/);
});

test('number formats (+91, spaces, hyphen, leading 0) all save the same 10 digits', () => {
  for (const f of ['9822700001', '+91 9822700001', '+91 98227 00001', '098227-00001', '91 98227 00001', '+919822700001']) {
    const st = shop();
    say(st, 'Agrawal traders ka number ' + f);
    assert.equal(ws(st, 'Agrawal Traders').phone, '9822700001', f);
  }
  const st = shop(); // a voice transcript
  const n0 = st.supplies.length;
  say(st, 'Modern Bakery ka number +91 98227 00002');
  assert.equal(ws(st, 'Modern Bakery').phone, '9822700002');
  assert.equal(st.supplies.length, n0, 'never read as a supplier udhaar');
});

test('a number that belongs to the owner, a customer or another wholesaler is refused with a reason', () => {
  const st = shop(['Agrawal Traders']);
  st.ownerPhone = '9800000001';
  let r = say(st, 'Modern Bakery ka number 9800000001');
  assert.match(r.owner, /apna \(dukaandaar ka\) number hai.*save nahi kiya/); assert.equal(ws(st, 'Modern Bakery').phone, null);
  r = say(st, 'Modern Bakery ka number 9822700010');
  assert.match(r.owner, /Agrawal Traders ka number hai.*save nahi kiya/); assert.equal(ws(st, 'Modern Bakery').phone, null);
  const cust = st.customers.find((c) => c.phone);
  r = say(st, 'Modern Bakery ka number ' + cust.phone);
  assert.match(r.owner, new RegExp(cust.name.replace(/[()]/g, '.') + ' \\(grahak\\) ka number hai')); assert.equal(ws(st, 'Modern Bakery').phone, null);
});

test('first "hi": owner is told the order can go, the wholesaler gets one short line, a later "hi" only reaches the owner', () => {
  const st = shop();
  const w = ws(st, 'Agrawal Traders'); w.phone = '9822700001';
  let r = fromWs(st, 'Agrawal Traders', 'hi');
  assert.equal(r.owner, '📦 Agrawal Traders ne hi bheja, ab order bhej sakte hain.');
  assert.equal(r.other.length, 1); assert.match(r.other[0].text, /^Namaste 🙏 Gupta Kirana Store ka order isi number par aayega/);
  assert.equal(w.wa, true);
  r = fromWs(st, 'Agrawal Traders', 'hello');
  assert.equal(r.other.length, 0);
});
