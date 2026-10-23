// Customer orders in the words customers really use. On 18 Oct a customer wrote "Shampoo bhi tha yaar usako bhi add
// karo", "entry anti dandruff shampoo add karo." and "Antidandruff shampoo add karo." right after his order, and got no
// reply at all: no rate was known for shampoo, so it was not read as an order, and the half-hour limits on the menu and
// on relays to the owner had already been used. Now any order phrasing is an order, an item without a rate still goes to
// the owner (who sets it), "add karo" after an order adds to it, and the customer always hears back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../core/agent-core.js');
const { createServer } = require('../server/server.js');

const TODAY = '2026-10-18';
const T0 = Date.UTC(2026, 9, 18, 18, 55, 0);
const MIN = 60 * 1000;
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

// the Gupta demo shop; chaaval has a remembered rate, as on the live shop
function shop() {
  const s = C.freshShop('gupta', TODAY);
  s.prices.chaval = { name: 'chaaval', rate: 60, unit: 'kg', date: '2026-10-17' };
  return s;
}
function khataCustomer(s, name, phone) {
  const c = C.customerFromWhatsapp(s, phone || '9000003102', name || 'Sarthak seth').cust;
  C.runAction(s, 'owner', { text: 'ok' }); // the owner opens the khata
  assert.strictEqual(c.guest, undefined);
  return c;
}
let clock = T0;
function say(s, c, text, intent) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: (clock += MIN), intent: intent ? { intent, method: '', amount: null, parser: 'llm' } : undefined });
  return split(s, n, c);
}
function owner(s, text, c) { const n = s.messages.length; C.runAction(s, 'owner', { text }); return split(s, n, c); }
function split(s, n, c) {
  const got = s.messages.slice(n).filter((m) => m.from === 'agent');
  return { cust: got.filter((m) => m.to === c.id), owner: got.filter((m) => m.to === 'owner'), custText: got.filter((m) => m.to === c.id).map((m) => m.text).join('\n'), ownerText: got.filter((m) => m.to === 'owner').map((m) => m.text).join('\n') };
}

test('the 18 Oct conversation: "anti dandruff shampoo add karo" after an order reaches the owner, who sets the rate', () => {
  for (const llm of [undefined, 'chitchat', 'question', 'order']) {
    const s = shop();
    const c = khataCustomer(s);
    // the first order, as on the live shop: chaaval priced from memory, daal without a rate
    let r = say(s, c, 'ek kilo chaaval, do kilo daal', llm === 'chitchat' ? 'order' : llm);
    assert.strictEqual(r.cust[0].kind, 'order-ask');
    assert.match(r.custText, /Daal 2 kilo \(daam dukaan par\)[^]*Jinka rate nahi likha, woh dukaan batayegi/);
    // his real answer, which used to get no reply
    r = say(s, c, 'khaate men likho abhi paise naheen hai mere paas. main jab aaoonga tab doonga.', llm === 'order' ? 'promise' : llm);
    assert.match(r.custText, /udhaar par\. Order dukaandaar ke paas hai/);
    assert.match(r.ownerText, /Naya order: Sarthak seth, udhaar par[^]*Daal 2 kilo \(daam\?\)[^]*Daal kitne rupaye kilo\?/);
    // "ok" alone cannot write an udhaar order with a missing rate: the rate is asked first
    r = owner(s, 'Ok', c);
    assert.match(r.ownerText, /Khate mein likhne se pehle: Daal kitne rupaye kilo\?/);
    assert.strictEqual(r.cust.length, 0);
    r = owner(s, '90', c);
    assert.match(r.ownerText, /Order pakka: Sarthak seth, ₹240 khate mein likh diya/);
    assert.strictEqual(s.txns[s.txns.length - 1].amount, 240);
    assert.strictEqual(s.prices.dal.rate, 90, 'the rate the owner gave is remembered');

    // then the messages that went unanswered
    r = say(s, c, 'Shampoo bhi tha yaar usako bhi add karo', llm);
    assert.match(r.custText, /Pichhle order mein jod rahe hain \(udhaar par\):\n {2}• Shampoo \(daam dukaan par\)[^]*Order dukaan ko bhej diya, rate dukaan batayegi/, String(llm));
    assert.match(r.ownerText, /➕ Pichhle order mein jodna: Sarthak seth, udhaar par\n {2}• Shampoo \(daam\?\)/);
    r = say(s, c, 'entry anti dandruff shampoo add karo.', llm);
    assert.match(r.custText, /Anti dandruff shampoo aapke order mein jod diya\. Order dukaan ko bhej diya, rate dukaan batayegi/);
    assert.match(r.ownerText, /Sarthak seth ne order mein joda: Anti dandruff shampoo/);
    assert.doesNotMatch(r.ownerText, /• Shampoo \(/, 'the exact item replaces the vague one');
    for (const t of ['Antidandruff shampoo add karo.', 'anti dndruf shampoo add karo']) {
      r = say(s, c, t, llm);
      assert.match(r.custText, /Anti dandruff shampoo pehle se aapke order mein hai/, t);
    }
    assert.strictEqual(s.orders.length, 2, 'one add-on order, not one per message');
    // the owner's rate is the owner's ok
    r = owner(s, 'shampoo 180', c);
    assert.match(r.ownerText, /Order pakka: Sarthak seth, ₹180 khate mein likh diya\. Kul baaki: ₹420/);
    const t = s.txns[s.txns.length - 1];
    assert.strictEqual(t.amount, 180); assert.strictEqual(t.items, 'anti dandruff shampoo'); assert.strictEqual(t.source, 'order');
    assert.ok(r.cust.some((m) => m.kind === 'entry-check' && /Anti dandruff shampoo = ₹180/.test(m.text)), 'the customer gets the bill to check');
    assert.strictEqual(C.customerOrder(s, 'anti dandruff shampoo chahiye').lines[0].price, 180, 'priced from memory next time');
  }
});

test('order phrasings: add karo, daal do, likh do, bhej do, chahiye, de dena, ek aur, with or without the AI', () => {
  const cases = {
    'anti dandruff shampoo add karo': 'Anti dandruff shampoo',
    'Clinic Plus shampoo daal do': 'Clinic plus shampoo',
    'ek Dairy Milk likh do': 'Dairy milk',
    '2 Maggi bhej do': 'Maggi ×2',
    'mujhe Surf Excel chahiye': 'Surf excel',
    'Lux sabun de dena': 'Lux sabun',
    'ek aur Parle-G': 'Parle-G',
    'Colgate toothpaste bhejna': 'Colgate toothpaste',
    'मुझे दो किलो चीनी चाहिए': 'Cheeni 2 kilo = ₹90'
  };
  for (const llm of [undefined, 'chitchat', 'question', 'greeting', 'order']) {
    for (const [text, item] of Object.entries(cases)) {
      const s = shop();
      const c = khataCustomer(s);
      const r = say(s, c, C.cleanTranscript(text), llm);
      assert.strictEqual(r.cust.length, 1, text + ' / ' + llm);
      assert.strictEqual(r.cust[0].kind, 'order-ask', text + ' / ' + llm);
      assert.ok(r.custText.includes('• ' + item), text + ' / ' + llm + ': ' + r.custText);
    }
  }
});

test('reading the items: multi-word names, voice spellings, "50 wala", "daal do" vs daal the lentil, repeats', () => {
  const s = shop();
  const one = (t) => C.customerOrder(s, t).lines.map((l) => [l.name, l.qty, l.unit, l.price]);
  const heard = C.cleanTranscript('एंटी डैंड्रफ शैम्पू ऐड करो');
  assert.deepStrictEqual(one(heard), [['anti dandruff shampoo', null, null, null]]);
  assert.ok(C.customerOrder(s, heard).cue, 'ऐड करो is "add karo"');
  assert.deepStrictEqual(one('Antidandruff shampoo add karo.'), [['anti dandruff shampoo', null, null, null]]);
  assert.deepStrictEqual(one('mere ko pachaas vaala condom de do.'), [['condom ₹50 wala', null, null, 50]]);
  assert.deepStrictEqual(one('2 kilo daal aur chaaval daal do'), [['daal', 2, 'kg', null], ['chaaval', null, null, 60]]);
  assert.deepStrictEqual(one('mere ko chaaval de do chaaval'), [['chaaval', null, null, 60]]);
  assert.deepStrictEqual(one('meri entry galat likh di'), []);
  assert.deepStrictEqual(one('bill bhej do'), []);
  assert.strictEqual(C.orderReply('khaate men likho abhi paise naheen hai'), 'udhaar');
  assert.strictEqual(C.orderReply('cash denge'), 'cash');
  assert.strictEqual(C.orderReply('suna kya?'), null);
});

test('chat is still chat: jokes, greetings and questions are not orders', () => {
  const s = shop();
  const c = khataCustomer(s);
  for (const t of ['Shopper', 'Sharma ji kaise ho', 'Old is gold', 'Gupta ji pe mera 5000 rupaye udhar hai', 'suna kya?', 'Hello']) {
    say(s, c, t);
    say(s, c, t, 'chitchat');
  }
  assert.strictEqual((s.orders || []).length, 0);
});

test('a new number (no khata) orders an item without a rate: cash only, the owner sees it and may give the rate', () => {
  const s = shop();
  const g = C.customerFromWhatsapp(s, '9811111111', 'Rahul').cust;
  owner(s, 'nahi', g); // no khata
  let r = say(s, g, 'anti dandruff shampoo add karo', 'question');
  assert.match(r.custText, /Order mila:\n {2}• Anti dandruff shampoo \(daam dukaan par\)[^]*Cash par ready karenge\. Order dukaan ko bhej diya, rate dukaan batayegi/);
  assert.match(r.ownerText, /Naya order: Rahul, cash par[^]*Anti dandruff shampoo kitne ka\? Daam likhiye[^]*ya \*ok\* \(daam dukaan par\)/);
  assert.ok(!r.cust.some((m) => m.kind === 'order-ask'), 'a guest is never offered udhaar');
  const k = s.txns.length;
  r = owner(s, 'ok', g);
  assert.strictEqual(s.txns.length, k, 'cash: nothing on the khata');
  assert.match(r.custText, /Order pakka! ₹0 \+ baaki cheezon ka daam dukaan batayegi, cash par/);
});

test('"add karo" while the order waits: one order grows; "nahi hai" from the owner drops an item and tells the customer', () => {
  const s = shop();
  const c = khataCustomer(s);
  say(s, c, 'chaaval 2 kilo bhej do');
  let r = say(s, c, 'anti dandruff shampoo bhi add karo');
  assert.strictEqual(s.orders.length, 1);
  assert.match(r.custText, /Anti dandruff shampoo jod diya\.\n🛒 Order ab:\n {2}• Chaaval 2 kilo = ₹120\n {2}• Anti dandruff shampoo \(daam dukaan par\)[^]*Udhaar mein likhein\?/);
  assert.strictEqual(r.cust[0].kind, 'order-ask');
  // anything unclear while the order waits gets the question again, never silence
  r = say(s, c, 'suna kya?', 'chitchat');
  assert.match(r.custText, /Aapka order ruka hua hai/);
  C.runAction(s, 'orderAnswer', { custId: c.id, orderId: s.orders[0].id, udhaar: true });
  r = owner(s, 'shampoo nahi hai', c);
  assert.match(r.custText, /Anti dandruff shampoo abhi dukaan mein nahi hai/);
  assert.match(r.ownerText, /Order pakka: Sarthak seth, ₹120 khate mein likh diya/);
});

// ---------------------------------------------------------------- over WhatsApp (linked device, fake library), voice
const OWNER = '919800000001', CUST = '919812345678';
const jid = (n) => n + '@s.whatsapp.net';
function fakeLib() {
  const lib = { sockets: [], sent: [], creds: { registered: false } };
  lib.DisconnectReason = { loggedOut: 401, restartRequired: 515, connectionClosed: 428 };
  lib.Browsers = { ubuntu: (n) => [n, 'Chrome', '1'] };
  lib.fetchLatestBaileysVersion = async () => { throw new Error('no network in tests'); };
  lib.useMultiFileAuthState = async (dir) => { fs.writeFileSync(path.join(dir, 'creds.json'), '{}'); return { state: { creds: lib.creds, keys: {} }, saveCreds() {} }; };
  lib.downloadMediaMessage = async () => Buffer.from('OggS fake voice');
  lib.makeWASocket = (opts) => {
    const s = { opts, ev: new EventEmitter(), user: { id: '919800000009:4@s.whatsapp.net' },
      sendMessage: async (to, content) => { lib.sent.push({ to, content }); return { key: { id: 'x' } }; },
      sendPresenceUpdate: async () => {}, updateMediaMessage: async (m) => m, end() {} };
    lib.sockets.push(s);
    return s;
  };
  lib.sock = () => lib.sockets[lib.sockets.length - 1];
  lib.texts = (n) => lib.sent.filter((x) => x.to === jid(n) && x.content.text).map((x) => x.content.text);
  return lib;
}
let seq = 0;
const wmsg = (from, content, extra) => Object.assign({ key: { remoteJid: jid(from), fromMe: false, id: 'O' + (++seq) }, pushName: 'Sarthak', message: content }, extra || {});
const txt = (t) => ({ conversation: t });
const VOICE = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } };

test('WhatsApp voice note "एंटी डैंड्रफ शैम्पू ऐड करो" with the AI calling it chit-chat: the customer is answered, the owner gets the order', async () => {
  const lib = fakeLib();
  const clockRef = { t: Date.parse('2026-10-18T18:55:00Z') };
  const calls = [];
  const fetch = async (url) => {
    url = String(url); calls.push(url);
    if (url.endsWith('/v1/speech-to-text')) return new Response(JSON.stringify({ text: 'एंटी डैंड्रफ शैम्पू ऐड करो' }), { status: 200 });
    if (url.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: 'chitchat', method: '', amount: 0 }) } }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const server = createServer({ env: { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-order-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: '+' + OWNER, ELEVENLABS_API_KEY: 'el-key', AGENT37_LLM_PROXY_URL: 'https://llm.test/v1' },
    today: () => TODAY, fetch, now: () => clockRef.t, waWebLib: lib, sleep: async (ms) => { clockRef.t += ms; } });
  await server.web.start();
  lib.sock().ev.emit('connection.update', { connection: 'open' });
  const inbound = async (...msgs) => { lib.sock().ev.emit('messages.upsert', { type: 'notify', messages: msgs }); await server.idle(); };
  try {
    await inbound(wmsg(CUST, txt('hi')));
    await inbound(wmsg(OWNER, txt('ok'))); // khata opened
    lib.sent.length = 0;
    await inbound(wmsg(CUST, VOICE));
    const k = lib.texts(CUST);
    assert.strictEqual(k.length, 1);
    assert.match(k[0], /Order mila:\n {2}• Anti dandruff shampoo \(daam dukaan par\)[^]*rate nahi likha, woh dukaan batayegi[^]*Udhaar mein likhein\?/);
    await inbound(wmsg(CUST, txt('haan')));
    assert.match(lib.texts(OWNER).join('\n'), /Naya order: Sarthak, udhaar par\n {2}• Anti dandruff shampoo \(daam\?\)[^]*Anti dandruff shampoo kitne ka\?/);
    const llmBefore = calls.filter((u) => u.endsWith('/chat/completions')).length;
    lib.sent.length = 0;
    await inbound(wmsg(OWNER, txt('180')));
    assert.strictEqual(calls.filter((u) => u.endsWith('/chat/completions')).length, llmBefore, 'a rate reply needs no AI call');
    const t = server.getState().txns.find((x) => x.source === 'order');
    assert.ok(t); assert.strictEqual(t.amount, 180);
    assert.match(lib.texts(OWNER).join('\n'), /Order pakka: Sarthak, ₹180 khate mein likh diya/);
    assert.match(lib.texts(CUST).join('\n'), /Order pakka![^]*Anti dandruff shampoo = ₹180/);
  } finally { server.close(); }
});
