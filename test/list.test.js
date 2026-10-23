// A customer's list: the owner reads out (or types) what one customer is taking ("Krish ki list: 2 kilo aata 80,
// Parle-G 10, doodh 30"). It goes on the khata item by item, an unknown rate is asked before anything is written, and
// the customer gets the list, this bill and their total udhaar to answer haan / galat.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../core/agent-core.js');
const { createServer } = require('../server/server.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

// the Gupta demo shop plus Krish, who already owes ₹1,330 and has a WhatsApp number (unless phone is null)
function shop(phone) {
  const st = C.freshShop('gupta', TODAY);
  st.customers.push({ id: 'C900', name: 'Krish', key: 'krish', phone: phone === undefined ? '9822700000' : phone, wa: true, vpas: [], dueDate: null, createdAt: TODAY });
  st.txns.push({ id: 'T900', custId: 'C900', type: 'credit', amount: 1330, items: '', date: '2026-10-01', dueDate: '2026-10-20', note: 'seed', source: 'text' });
  return st;
}
function say(st, text, source) {
  const n = st.messages.length, before = st.txns.length;
  C.runAction(st, 'owner', { text, source: source || 'text' });
  const out = st.messages.slice(n).filter((m) => m.from === 'agent');
  return { owner: out.filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), toKrish: out.filter((m) => m.to === 'C900'), added: st.txns.slice(before) };
}

test('list: written item by item, and Krish gets the list, this bill and the total udhaar to say haan / galat', () => {
  const st = shop();
  const r = say(st, 'Krish ki list: 2 kilo aata 80, ek Parle-G 10, doodh 30');
  assert.equal(r.added.length, 1);
  const t = r.added[0];
  assert.equal(t.custId, 'C900'); assert.equal(t.type, 'credit'); assert.equal(t.amount, 120); assert.equal(t.via, 'list');
  assert.deepEqual(t.lines.map((l) => [l.name, l.qty, l.unit, l.price]), [['aata', 2, 'kg', 80], ['parle-g', null, null, 10], ['doodh', null, null, 30]]);
  assert.equal(r.toKrish.length, 1);
  assert.equal(r.toKrish[0].kind, 'entry-check');
  assert.equal(r.toKrish[0].text,
    'Gupta Kirana Store: aaj aapne liya\n' +
    '- Aata 2 kg ₹80\n' +
    '- Parle-G ₹10\n' +
    '- Doodh ₹30\n' +
    'Is baar: ₹120 | Kul udhaar: ₹1,450\n' +
    'Sahi hai? haan / galat likhein');
  // the owner gets a short confirmation
  assert.match(r.owner, /^✅ Krish ki list khate mein likhi: ₹120/);
  assert.match(r.owner, /Kul udhaar: ₹1,450/);
  assert.match(r.owner, /📤 Krish ko list WhatsApp par bhej rahe hain/);
  assert.match(r.owner, /Naya daam yaad kiya: .*Parle-G ₹10/);
});

test('list phrasings: "ka saman", "list bana raha hoon X ki ... khatam", spoken numbers, counts and remembered rates', () => {
  let st = shop();
  let r = say(st, 'Krish ka saman: 2 kilo aata 80, doodh 30');
  assert.equal(r.added[0].amount, 110); assert.equal(r.added[0].via, 'list');

  st = shop();
  r = say(st, 'haan, list bana raha hoon Krish ki, 2 kilo aata 80, ek parle g 10, doodh 30, khatam');
  assert.equal(r.added[0].amount, 120);
  assert.deepEqual(r.added[0].lines.map((l) => l.name), ['aata', 'parle-g', 'doodh']);

  // "paanch sau" and "tees" are amounts; "paanch kilo" and "dedh kilo" are quantities; "sabun do" is two soaps
  st = shop();
  st = shop();
  r = say(st, 'Krish ki list: maggi das, parle g das'); // maggi is ₹14, so "das" maggi is ten packets; Parle-G has no rate yet, so ₹10
  assert.deepEqual(r.added[0].lines.map((l) => [l.name, l.qty, l.price]), [['maggi', 10, 140], ['parle-g', null, 10]]);
  st = shop();
  r = say(st, 'Krish ki list: chawal paanch kilo paanch sau, doodh tees');
  assert.deepEqual(r.added[0].lines.map((l) => [l.name, l.qty, l.price]), [['chawal', 5, 500], ['doodh', null, 30]]);
  st = shop();
  r = say(st, 'Krish ki list: dedh kilo cheeni, tel ek litre, maggi'); // every rate from the shop's memory
  assert.deepEqual(r.added[0].lines.map((l) => [l.name, l.qty, l.from]), [['cheeni', 1.5, 'memory'], ['tel', 1, 'memory'], ['maggi', null, 'memory']]);
  assert.match(r.owner, /🧠 Daam yaad se/);

  // a total said aloud wins, and the gap is shown
  st = shop();
  r = say(st, 'Krish ki list: aata 2 kilo 84, doodh 30, total 110');
  assert.equal(r.added[0].amount, 110);
  assert.match(r.owner, /⚠️ Items ka jod ₹114, bola gaya total ₹110/);

  // not lists: plain entries and questions keep their old meaning
  for (const s of ['Sharma ji ka bill 340', 'Pappu ka saman 200 likh do', 'Sharma ji ka hisaab', 'aaj ka saman bahut aaya']) assert.equal(C.listIntent(st, s), null, s);
});

test('list with an item of unknown rate: the owner is asked, nothing is written or sent until answered; the rate is remembered', () => {
  const st = shop();
  let r = say(st, 'Krish ki list: 2 kilo aata, parle-g, doodh');
  assert.equal(r.added.length, 0, 'nothing written');
  assert.equal(r.toKrish.length, 0, 'nothing sent');
  assert.match(r.owner, /Parle-G kitne ka\?/);
  assert.match(r.owner, /Aata 2 kg ₹84, Parle-G \?, Doodh ₹30/);
  r = say(st, 'das rupaye');
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].amount, 124);
  assert.match(r.toKrish[0].text, /- Parle-G ₹10\n/);
  assert.match(r.owner, /Naya daam yaad kiya: Parle-G ₹10/);
  // next time Parle-G needs no price
  r = say(st, 'Krish ki list: parle-g, doodh');
  assert.equal(r.added[0].amount, 40);

  // two unknown items are asked one after another; a counted item is asked per piece
  r = say(st, 'Krish ki list: sabun do, colgate');
  assert.match(r.owner, /Sabun ek kitne ka\?/);
  r = say(st, '35');
  assert.equal(r.added.length, 0);
  assert.match(r.owner, /Colgate kitne ka\?/);
  r = say(st, 'colgate 55');
  assert.equal(r.added[0].amount, 125);

  // "cancel" drops the list; a new message instead of a rate drops it too and is read as usual
  say(st, 'Krish ki list: dettol');
  r = say(st, 'cancel');
  assert.equal(r.added.length, 0); assert.match(r.owner, /list chhod di/);
  say(st, 'Krish ki list: dettol');
  r = say(st, 'Pappu ne 100 jama kiye');
  assert.match(r.owner, /list adhoori chhod di \(Dettol ka daam nahi mila\)/);
  assert.equal(r.added.length, 1); assert.equal(r.added[0].type, 'payment');
});

test('list for a customer without a number: written in the khata only, and the owner is told', () => {
  const st = shop(null);
  const r = say(st, 'Krish ki list: 2 kilo aata 80, doodh 30');
  assert.equal(r.added[0].amount, 110);
  assert.equal(r.toKrish.length, 0);
  assert.match(r.owner, /📵 Krish ka number nahi hai, sirf khate mein likha/);
});

test('Krish says "galat": the existing dispute flow flags it to the owner', () => {
  const st = shop();
  const r = say(st, 'Krish ki list: 2 kilo aata 80, doodh 30');
  const n = st.messages.length;
  C.runAction(st, 'customerCheck', { custId: 'C900', msgId: r.toKrish[0].id, ok: false });
  const owner = st.messages.slice(n).find((m) => m.to === 'owner');
  assert.match(owner.text, /Krish ne ₹110 udhaar .* galat bataya/);
  assert.equal(C.pendingClaims(st).filter((k) => k.type === 'check').length, 1);
});

// ---------------------------------------------------------------- over WhatsApp (linked device, fake library)
const OWNER = '919800000001', KRISH = '919812345678';
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
const wmsg = (from, content, extra) => Object.assign({ key: { remoteJid: jid(from), fromMe: false, id: 'L' + (++seq) }, pushName: 'Someone', message: content }, extra || {});
const txt = (t) => ({ conversation: t });
const VOICE = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } };
async function webServer(env, heard, llm) {
  const lib = fakeLib();
  const clock = { t: Date.parse('2026-10-08T10:00:00Z') };
  const calls = [];
  const fetch = async (url, init) => {
    url = String(url); calls.push(url);
    if (url.endsWith('/v1/speech-to-text')) return new Response(JSON.stringify({ text: heard() }), { status: 200 });
    if (url.endsWith('/chat/completions') && llm) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llm()) } }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const server = createServer({ env: Object.assign({ SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-list-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: '+' + OWNER, ELEVENLABS_API_KEY: 'el-key' }, env || {}),
    today: () => TODAY, fetch, now: () => clock.t, waWebLib: lib, sleep: async (ms) => { clock.t += ms; } });
  await server.web.start();
  lib.sock().ev.emit('connection.update', { connection: 'open' });
  const inbound = async (...msgs) => { lib.sock().ev.emit('messages.upsert', { type: 'notify', messages: msgs }); await server.idle(); };
  return { server, lib, inbound, calls };
}

test('WhatsApp voice note: a Devanagari list reaches the khata and Krish gets it as text, once, with haan / galat', async () => {
  const heard = 'कृष की लिस्ट, दो किलो आटा अस्सी, एक पारले जी दस, दूध तीस, खतम';
  const { server, lib, inbound } = await webServer({}, () => heard);
  try {
    await inbound(wmsg(KRISH, txt('hi'), { pushName: 'Krish' }));
    await inbound(wmsg(OWNER, txt('ok'))); // the owner opens Krish's khata
    lib.sent.length = 0;
    await inbound(wmsg(OWNER, VOICE));
    const t = server.getState().txns.find((x) => x.via === 'list');
    assert.ok(t, 'list written');
    assert.equal(t.amount, 120); assert.equal(t.source, 'voice');
    assert.match(lib.texts(OWNER).join('\n'), /Suna: "कृष की लिस्ट/);
    assert.match(lib.texts(OWNER).join('\n'), /✅ Krish ki list khate mein likhi: ₹120/);
    const k = lib.texts(KRISH);
    assert.equal(k.length, 1);
    assert.equal(k[0], 'Gupta Kirana Store: aaj aapne liya\n- Aata 2 kg ₹80\n- Parle-G ₹10\n- Doodh ₹30\nIs baar: ₹120 | Kul udhaar: ₹120\nSahi hai? haan / galat likhein'.replace('Gupta Kirana Store', server.getState().shop.name));
    // Krish answers "galat": the owner hears about it
    lib.sent.length = 0;
    await inbound(wmsg(KRISH, txt('galat')));
    assert.match(lib.texts(OWNER).join('\n'), /Krish ne ₹120 udhaar .* galat bataya/);

  } finally { server.close(); }
});

test('WhatsApp text list with the AI on: the AI reads it, the list is still written item by item, unknown rate asked, and a number that never wrote is told to the owner', async () => {
  const { server, lib, inbound, calls } = await webServer({ AGENT37_LLM_PROXY_URL: 'https://llm.test/v1' }, () => '', () => ({ intent: 'unknown', name: '', items: '', amount: 0, due_date: '', phone: '', canon: '', ask: '' }));
  try {
    await inbound(wmsg(OWNER, txt('Krish ki list: 2 kilo aata 80, parle g')));
    assert.ok(calls.some((u) => u.endsWith('/chat/completions')), 'every owner message is read by the AI first');
    assert.match(lib.texts(OWNER).join('\n'), /Parle-G kitne ka\?/);
    assert.equal(server.getState().txns.length, 0);
    const asked = calls.filter((u) => u.endsWith('/chat/completions')).length;
    await inbound(wmsg(OWNER, txt('10')));
    assert.equal(calls.filter((u) => u.endsWith('/chat/completions')).length, asked, 'the answer to "kitne ka?" needs no AI call');
    assert.equal(server.getState().txns.find((x) => x.via === 'list').amount, 90);
    assert.match(lib.texts(OWNER).join('\n'), /📵 Krish ka number nahi hai, sirf khate mein likha/);
    // Krish has a number now but never wrote to the shop: nothing goes to him and the owner knows why
    server.getState().customers.find((x) => x.name === 'Krish').phone = '9812345678';
    lib.sent.length = 0;
    await inbound(wmsg(OWNER, txt('Krish ki list: parle g, aata 1 kilo')));
    assert.equal(lib.texts(KRISH).length, 0);
    assert.match(lib.texts(OWNER).join('\n'), /⚠️ Krish ko list WhatsApp par nahi gayi: unhone abhi tak dukaan ke number par "hi" nahi bheja/);
  } finally { server.close(); }
});

test('AI rewrite of a messy voice list: rates the owner never said are not used', () => {
  const st = shop();
  // heard: "krish ka ... aata do kilo assi ... parle g"; the AI rewrite adds "Parle-G 50", which was never said
  const out = C.handleOwnerMessage(st, 'haan wo krish ka, aata do kilo assi aur parle g bas', { source: 'voice', intent: { intent: 'credit', parser: 'llm', canon: 'Krish ki list: aata 2 kilo 80, Parle-G 50' } });
  assert.equal(st.txns.filter((t) => t.via === 'list').length, 0);
  assert.match(out.messages[0].text, /Parle-G kitne ka\?/);
  const p = C.llmRequestParts('Krish ki list', st);
  assert.ok(p.system.includes('Krish ki list: 2 kilo aata 80'), 'the AI prompt knows the list phrasing');
});
