// The linked-device transport (WA_PROVIDER=web): inbound parsing into the shared handler, the slow capped send
// queue, the /link page's key, and logout. The WhatsApp Web library is replaced by a fake; nothing touches the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createServer } = require('../server/server.js');
const { createWebTransport, parseWebMessage } = require('../server/wa-web.js');
const C = require('../core/agent-core.js');

const TODAY = '2026-10-08';
const OWNER = '919800000001', JUDGE = '919812345678';
const jid = (n) => n + '@s.whatsapp.net';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }

// Stands in for @whiskeysockets/baileys: records sockets, sends and presence updates.
function fakeLib() {
  const lib = { sockets: [], sent: [], presence: [], downloads: 0, creds: { registered: false } };
  lib.DisconnectReason = { loggedOut: 401, restartRequired: 515, connectionClosed: 428 };
  lib.Browsers = { ubuntu: (n) => [n, 'Chrome', '1'] };
  lib.fetchLatestBaileysVersion = async () => { throw new Error('no network in tests'); };
  lib.useMultiFileAuthState = async (dir) => { fs.writeFileSync(path.join(dir, 'creds.json'), '{}'); return { state: { creds: lib.creds, keys: {} }, saveCreds() {} }; };
  lib.downloadMediaMessage = async () => { lib.downloads++; return Buffer.from('OggS fake voice'); };
  lib.makeWASocket = (opts) => {
    const ev = new EventEmitter();
    const s = { opts, ev, user: { id: '919800000009:4@s.whatsapp.net' }, ended: false,
      sendMessage: async (to, content) => { lib.sent.push({ to, content }); return { key: { id: 'x' } }; },
      sendPresenceUpdate: async (p, to) => { lib.presence.push([p, to]); },
      updateMediaMessage: async (m) => m, end() { s.ended = true; } };
    lib.sockets.push(s);
    return s;
  };
  lib.sock = () => lib.sockets[lib.sockets.length - 1];
  lib.connect = () => lib.sock().ev.emit('connection.update', { connection: 'open' });
  lib.texts = (n) => lib.sent.filter((x) => x.to === jid(n) && x.content.text).map((x) => x.content.text);
  lib.clear = () => { lib.sent.length = 0; lib.presence.length = 0; };
  return lib;
}

// A text message as Baileys hands it over.
let seq = 0;
function wmsg(from, content, extra) {
  return Object.assign({ key: { remoteJid: jid(from), fromMe: false, id: 'W' + (++seq) }, pushName: 'Someone', message: content }, extra || {});
}
const txt = (t) => ({ conversation: t });

function fakeFetch(heard, llm) {
  const calls = [];
  const f = async (url, init) => {
    url = String(url); calls.push({ url, init });
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: heard || '' }), { status: 200 });
    if (url.endsWith('/v1/speech-to-text')) return new Response(JSON.stringify({ language_code: 'hin', text: typeof heard === 'function' ? heard() : heard || '' }), { status: 200 });
    if (url.endsWith('/chat/completions') && llm) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llm(JSON.parse(init.body))) } }] }), { status: 200 });
    if (url.includes('/v1/text-to-speech/')) return new Response(Buffer.from('OggS fake tts'), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  f.calls = calls;
  return f;
}

async function webServer(extraEnv, heard, llm) {
  const lib = fakeLib();
  const clock = { t: Date.parse('2026-10-08T10:00:00Z') };
  const slept = [];
  const env = Object.assign({ SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-web-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: '+' + OWNER }, extraEnv || {});
  const fetch = fakeFetch(heard, llm);
  const server = createServer({ env, today: () => TODAY, fetch, now: () => clock.t, waWebLib: lib, sleep: async (ms) => { slept.push(ms); clock.t += ms; } });
  if (server.web && env.WA_PROVIDER === 'web') await server.web.start();
  return { server, lib, clock, slept, env, fetch };
}
async function inbound(server, lib, ...msgs) {
  lib.sock().ev.emit('messages.upsert', { type: 'notify', messages: msgs });
  await server.idle();
}

test('parsing: text, captions, voice notes, button-less replies and @lid senders; groups, status, own and protocol messages are ignored', () => {
  const p = (m) => parseWebMessage(m);
  assert.deepEqual(p(wmsg(JUDGE, txt('cash de diya'), { pushName: 'Rohit' })), { id: 'W' + seq, from: JUDGE, name: 'Rohit', text: 'cash de diya', audio: null });
  assert.equal(p(wmsg(JUDGE, { extendedTextMessage: { text: 'haan', contextInfo: {} } })).text, 'haan');
  assert.equal(p(wmsg(JUDGE, { ephemeralMessage: { message: { extendedTextMessage: { text: 'galat' } } } })).text, 'galat');
  assert.equal(p(wmsg(JUDGE, { imageMessage: { caption: 'yeh bill' } })).text, 'yeh bill');
  assert.equal(p(wmsg(JUDGE, { buttonsResponseMessage: { selectedDisplayText: 'Haan' } })).text, 'Haan');
  const v = p(wmsg(JUDGE, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }));
  assert.equal(v.audio.type, 'audio/ogg');
  assert.ok(v.audio.web.key);
  // newer WhatsApp: a hidden @lid id, with the phone number alongside
  assert.equal(p({ key: { remoteJid: '1234567@lid', remoteJidAlt: jid(JUDGE), id: 'L1' }, message: txt('hi') }).from, JUDGE);
  assert.equal(p({ key: { remoteJid: '1234567@lid', id: 'L2' }, message: txt('hi') }), null); // no number to answer
  assert.equal(p({ key: { remoteJid: '120363000000@g.us', participant: jid(JUDGE), id: 'G' }, message: txt('Rohit 500 udhaar') }), null);
  assert.equal(p({ key: { remoteJid: 'status@broadcast', participant: jid(JUDGE), id: 'S' }, message: txt('status') }), null);
  assert.equal(p({ key: { remoteJid: '12345@broadcast', id: 'B' }, message: txt('list') }), null);
  assert.equal(p({ key: { remoteJid: '1203@newsletter', id: 'N' }, message: txt('channel') }), null);
  assert.equal(p(wmsg(JUDGE, txt('my own'), { key: { remoteJid: jid(JUDGE), fromMe: true, id: 'F' } })), null);
  assert.equal(p(wmsg(JUDGE, { protocolMessage: { type: 0 } })), null);
  assert.equal(p(wmsg(JUDGE, { reactionMessage: { text: '👍' } })), null);
  assert.equal(p(wmsg(JUDGE, null)), null);
});

test('inbound goes through the same handler as Twilio: join, bill, haan, cash claim, owner confirms; no 24h window', async () => {
  const { server, lib, clock } = await webServer();
  try {
    lib.connect();
    await inbound(server, lib, wmsg(OWNER, txt('aaj ka hisaab')));
    assert.ok(lib.texts(OWNER).length >= 1);
    lib.clear();

    await inbound(server, lib, wmsg(JUDGE, txt('hi'), { pushName: 'Rohit Sharma' }));
    assert.match(lib.texts(JUDGE)[0], /Namaste Rohit Sharma 🙏 Aap .* se jud gaye/);
    const rohit = server.getState().customers.find((c) => c.phone === '9812345678');
    assert.ok(rohit && rohit.wa);
    lib.clear();

    await inbound(server, lib, wmsg(OWNER, txt('ok')));
    await inbound(server, lib, wmsg(OWNER, txt('Rohit ji cheeni 2 kilo 90, tel 1 litre 180')));
    assert.match(lib.texts(JUDGE).join('\n'), /₹270/);
    lib.clear();

    // a button-less one-word reply
    await inbound(server, lib, wmsg(JUDGE, { extendedTextMessage: { text: 'Haan' } }));
    assert.match(lib.texts(JUDGE)[0], /sahi bataya/);
    lib.clear();

    await inbound(server, lib, wmsg(JUDGE, txt('cash de diya')));
    assert.match(lib.texts(JUDGE)[0], /₹270 cash note kar liya/);
    assert.match(lib.texts(OWNER).pop(), /⏳ Rohit Sharma: ₹270 cash/);
    lib.clear();
    await inbound(server, lib, wmsg(OWNER, txt('haan')));
    assert.match(lib.texts(OWNER)[0], /₹270 cash jama/);
    assert.equal(C.balance(server.getState(), rohit.id), 0);

    // the same message id twice is acted on once
    const again = wmsg(OWNER, txt('Pappu 100 udhaar'));
    await inbound(server, lib, again, again);
    assert.equal(server.getState().txns.filter((t) => t.amount === 100).length, 1);

    // groups, status and our own messages change nothing
    const n = server.getState().messages.length;
    await inbound(server, lib,
      { key: { remoteJid: '1203@g.us', participant: jid(OWNER), id: 'g1' }, message: txt('Rohit 500 udhaar') },
      { key: { remoteJid: 'status@broadcast', participant: jid(OWNER), id: 's1' }, message: txt('Rohit 500 udhaar') },
      { key: { remoteJid: jid(OWNER), fromMe: true, id: 'f1' }, message: txt('Rohit 500 udhaar') });
    assert.equal(server.getState().messages.length, n);

    // two days later a business-initiated message is still plain text (no template, no 24h window)
    lib.clear();
    clock.t += 50 * 60 * 60 * 1000;
    const st = server.getState();
    server.whatsapp.deliver(st, st.messages.length, ['Evening summary']);
    await server.idle();
    assert.deepEqual(lib.texts(OWNER), ['Evening summary']);

    // the Twilio webhook is off while web is the provider; health shows the link
    const base = await listen(server);
    assert.equal((await fetch(base + '/whatsapp', { method: 'POST', body: 'a=b' })).status, 404);
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.whatsapp.provider, 'web');
    assert.equal(h.whatsapp.web.state, 'connected');
    assert.equal(h.whatsapp.web.number, '+xxxxxxxx0009');
  } finally { server.close(); }
});

test('voice notes: the audio is downloaded and sent to speech-to-text; ElevenLabs replies go as push-to-talk', async () => {
  const { server, lib, fetch } = await webServer({ STT_URL: 'http://stt.test/v1', ELEVENLABS_API_KEY: 'el', WA_VOICE_REPLIES: '1' }, 'Pappu 200 udhaar');
  try {
    lib.connect();
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }));
    assert.equal(lib.downloads, 1);
    assert.ok(fetch.calls.some((c) => c.url === 'http://stt.test/v1/audio/transcriptions'));
    assert.match(lib.texts(OWNER)[0], /Suna: "Pappu 200 udhaar"/);
    assert.equal(server.getState().txns.filter((t) => t.amount === 200).length, 1);

    // a customer who wrote first gets the bill as text and then a voice note
    await inbound(server, lib, wmsg(JUDGE, txt('hi'), { pushName: 'Rohit' }));
    await inbound(server, lib, wmsg(OWNER, txt('ok')));
    lib.clear();
    await inbound(server, lib, wmsg(OWNER, txt('Rohit ji cheeni 2 kilo 90')));
    const toJudge = lib.sent.filter((x) => x.to === jid(JUDGE));
    assert.ok(toJudge[0].content.text);
    const voice = toJudge.find((x) => x.content.audio);
    assert.ok(voice, 'voice note sent');
    assert.equal(voice.content.ptt, true);
    assert.match(voice.content.mimetype, /ogg/);
    assert.ok(fetch.calls.some((c) => /output_format=opus/.test(c.url)));
    assert.ok(lib.presence.some(([p]) => p === 'recording'));
  } finally { server.close(); }
});

test('send queue: one at a time, 2-4 s apart with typing first, hourly cap on business-initiated sends only', async () => {
  const lib = fakeLib();
  const clock = { t: 1e12 };
  const slept = [];
  let got = null;
  const web = createWebTransport({ authDir: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-webq-')), loadLib: async () => lib, maxPerHour: 3,
    now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; }, random: () => 0.5, onMessage: (m) => { got = m; } });
  // not linked yet: nothing goes, nothing queues forever
  assert.equal(await web.send(JUDGE, { text: 'early' }), false);
  await web.start();
  lib.connect();
  const times = [];
  const orig = lib.sock().sendMessage;
  lib.sock().sendMessage = async (to, c) => { times.push(clock.t); return orig(to, c); };
  const r = await Promise.all([web.send(JUDGE, { text: 'one' }), web.send(JUDGE, { text: 'two' }), web.send(JUDGE, { text: 'three' }), web.send(JUDGE, { text: 'four' })]);
  assert.deepEqual(r, [true, true, true, false]); // 4th business-initiated send in the hour is dropped
  assert.deepEqual(lib.texts(JUDGE), ['one', 'two', 'three']);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2000 && times[i] - times[i - 1] <= 4000 + 2500, 'gap ' + (times[i] - times[i - 1]));
  assert.deepEqual(lib.presence.slice(0, 2).map((x) => x[0]), ['composing', 'paused']);
  assert.equal(web.status().capped, 1);
  assert.equal(web.status().businessLastHour, 3);

  // a reply to someone who just wrote is not business-initiated, so the cap does not stop it
  lib.sock().ev.emit('messages.upsert', { type: 'notify', messages: [wmsg(JUDGE, txt('hello'))] });
  assert.equal(got.text, 'hello');
  assert.equal(await web.send(JUDGE, { text: 'reply' }), true);
  // history sync ('append') is never treated as new messages
  got = null;
  lib.sock().ev.emit('messages.upsert', { type: 'append', messages: [wmsg(JUDGE, txt('old'))] });
  assert.equal(got, null);
  // an hour later the cap is free again
  clock.t += 61 * 60 * 1000;
  assert.equal(await web.send(OWNER, { text: 'later' }), true);
  web.stop();
});

test('/link: 403 without the right key; with it a QR, then the connected status; works while Twilio is the provider', async () => {
  // no LINK_KEY: always 403
  const none = createServer({ env: { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-web-')) }, today: () => TODAY });
  const b0 = await listen(none);
  try {
    assert.equal((await fetch(b0 + '/link')).status, 403);
    assert.equal((await fetch(b0 + '/link?key=')).status, 403);
    assert.equal((await (await fetch(b0 + '/healthz')).json()).whatsapp.web, null);
  } finally { none.close(); }

  const { server, lib, env } = await webServer({ WA_PROVIDER: '', LINK_KEY: 'k3y-0123456789ab', TWILIO_AUTH_TOKEN: 't', OWNER_WHATSAPP: '+' + OWNER });
  const base = await listen(server);
  try {
    assert.equal(lib.sockets.length, 0); // twilio mode: nothing connects until /link is opened
    assert.equal((await fetch(base + '/link')).status, 403);
    assert.equal((await fetch(base + '/link?key=wrong')).status, 403);
    assert.equal((await fetch(base + '/link?key=k3y-0123456789aB')).status, 403);
    let r = await fetch(base + '/link?key=' + env.LINK_KEY);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await r.text(), /meta http-equiv="refresh"/);
    assert.equal(lib.sockets.length, 1);
    lib.sock().ev.emit('connection.update', { qr: '2@abcdefghijklmnopqrstuvwxyz0123456789,ABCDEFGHIJ=,KLMNOP=,QRST=' });
    let html = await (await fetch(base + '/link?key=' + env.LINK_KEY)).text();
    assert.match(html, /<svg/);
    assert.match(html, /Linked devices/);
    lib.connect();
    html = await (await fetch(base + '/link?key=' + env.LINK_KEY)).text();
    assert.match(html, /Jud gaya/);
    assert.match(html, /WA_PROVIDER=web/);
    // linked early but still on Twilio: its chats are not answered and nothing is sent from it
    await inbound(server, lib, wmsg(OWNER, txt('Rohit 500 udhaar')));
    assert.equal(server.getState().txns.length, 0);
    assert.equal(lib.sent.length, 0);
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.whatsapp.provider, 'twilio');
    assert.equal(h.whatsapp.web.state, 'connected');
  } finally { server.close(); }
});

test('logout from the phone clears the saved link and shows a fresh QR; other drops reconnect', async () => {
  const { server, lib, env } = await webServer();
  const auth = path.join(env.DATA_DIR, 'wa-web-auth');
  try {
    assert.ok(fs.existsSync(path.join(auth, 'creds.json')));
    lib.connect();
    lib.sock().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'Stream Errored', output: { statusCode: 401 } } } });
    assert.equal(fs.existsSync(auth), false);
    assert.equal(server.web.status().state, 'logged_out');
    await new Promise((r) => setTimeout(r, 2200)); // the fresh session starts on its own
    assert.equal(lib.sockets.length, 2);
    lib.sock().ev.emit('connection.update', { qr: 'fresh-qr' });
    assert.equal(server.web.qr(), 'fresh-qr');
    // a network drop with the link intact reconnects (restart-required right away)
    lib.creds.registered = true;
    lib.connect();
    lib.sock().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    assert.equal(server.web.status().state, 'reconnecting');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(lib.sockets.length, 3);
  } finally { server.close(); }
});

test('voice is input only: with just an ElevenLabs key, voice notes are transcribed by ElevenLabs and every answer is text', async () => {
  let heard = 'शर्मा जी के खाते में पाँच सौ रुपये उधार लिखो';
  const { server, lib, fetch } = await webServer({ ELEVENLABS_API_KEY: 'el-key' }, () => heard);
  try {
    lib.connect();
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }));
    const stt = fetch.calls.find((c) => c.url === 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.ok(stt, 'ElevenLabs speech-to-text called');
    assert.equal(stt.init.headers['xi-api-key'], 'el-key');
    assert.equal(stt.init.body.get('model_id'), 'scribe_v1');
    assert.equal(stt.init.body.get('language_code'), 'hi');
    assert.equal(stt.init.body.get('tag_audio_events'), 'false');
    assert.match(lib.texts(OWNER)[0], /Suna: "शर्मा जी/); // the owner sees exactly what was heard
    const t = server.getState().txns.find((x) => x.amount === 500);
    assert.ok(t, '"paanch sau" written as 500');
    assert.equal(server.getState().customers.find((c) => c.id === t.custId).name, 'Sharma ji');
    assert.equal(t.source, 'voice');

    // a customer's voice note goes through the same customer flow, answered in text
    await inbound(server, lib, wmsg(JUDGE, txt('hi'), { pushName: 'Rohit' }));
    await inbound(server, lib, wmsg(OWNER, txt('ok')));
    await inbound(server, lib, wmsg(OWNER, txt('Rohit ji 300 udhaar')));
    lib.clear();
    heard = 'मेरा कितना बाकी है';
    await inbound(server, lib, wmsg(JUDGE, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }));
    assert.match(lib.texts(JUDGE).join('\n'), /₹300/);

    // nobody ever gets a voice note back: no text-to-speech call, no audio sent
    assert.ok(!fetch.calls.some((c) => c.url.includes('/v1/text-to-speech/')));
    assert.ok(!lib.sent.some((x) => x.content.audio));
    const h = await (await globalThis.fetch((await listen(server)) + '/healthz')).json();
    assert.equal(h.whatsapp.voice, true);
    assert.equal(h.whatsapp.voiceProvider, 'elevenlabs');
    assert.equal(h.whatsapp.voiceNotes, false);
  } finally { server.close(); }
});

test('voice: STT_PROVIDER=off or no key refuses voice notes politely in text; nothing is written', async () => {
  for (const env of [{ ELEVENLABS_API_KEY: 'el-key', STT_PROVIDER: 'off' }, {}]) {
    const { server, lib, fetch } = await webServer(env, 'Pappu 200 udhaar');
    try {
      lib.connect();
      await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg', ptt: true } }));
      assert.match(lib.texts(OWNER)[0], /Voice note abhi chalu nahi hai/);
      assert.equal(server.getState().txns.length, 0);
      assert.ok(!fetch.calls.some((c) => /speech-to-text|transcriptions/.test(c.url)));
    } finally { server.close(); }
  }
});

test('voice + AI: a misheard amount is never invented, a garbled note gets a short question, a supplier note goes to the supplier khata', async () => {
  let heard = '', reply = null;
  const { server, lib } = await webServer({ ELEVENLABS_API_KEY: 'el-key', AGENT37_LLM_PROXY_URL: 'https://llm.test/v1' }, () => heard, () => reply);
  try {
    lib.connect();
    // the AI says 700 but the voice note only said "paanch sau": the stated 500 is not there either, so nothing is guessed
    heard = 'Pappu ka udhaar likho';
    reply = { intent: 'credit', name: 'Pappu', items: '', amount: 700, due_date: '', phone: '', canon: 'Pappu 700 udhaar', ask: '' };
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg', ptt: true } }));
    assert.equal(server.getState().txns.length, 0);
    assert.match(lib.texts(OWNER).join('\n'), /Pappu ka kitne rupaye udhaar\? .*Entry abhi nahi likhi/);
    lib.clear();

    // "dedh hazaar" becomes 1500 before the AI reads it, so the AI's 1500 is backed by the words
    reply = { intent: 'credit', name: 'Pappu', items: '', amount: 2000, due_date: '', phone: '', canon: 'Pappu 2000 udhaar', ask: '' };
    await inbound(server, lib, wmsg(OWNER, txt('Pappu do hazaar udhaar')));
    assert.equal(server.getState().txns.filter((t) => t.type === 'credit' && t.amount === 2000).length, 1, 'typed number words back the AI amount too');
    heard = 'पप्पू ने डेढ़ हज़ार जमा किए';
    reply = { intent: 'payment', name: 'Pappu', items: '', amount: 1500, due_date: '', phone: '', canon: 'Pappu ne 1500 jama kiye', ask: '' };
    lib.clear();
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg', ptt: true } }));
    assert.equal(server.getState().txns.filter((t) => t.type === 'payment' && t.amount === 1500).length, 1);
    lib.clear();

    // too garbled: the AI's one short question goes to the owner
    heard = 'haan wo... uska... kal wala';
    reply = { intent: 'unknown', name: '', items: '', amount: 0, due_date: '', phone: '', canon: '', ask: 'Kiska aur kitne ka hisaab likhun?' };
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg', ptt: true } }));
    assert.match(lib.texts(OWNER).join('\n'), /🤔 Kiska aur kitne ka hisaab likhun\?/);
    lib.clear();

    // a supplier note in loose words: the AI's clean rewrite reaches the supplier khata, not a new customer
    heard = 'वो अग्रवाल वाले का पाँच हज़ार का माल आया उधार में';
    reply = { intent: 'supplier', name: 'Agrawal Traders', items: '', amount: 5000, due_date: '', phone: '', canon: 'Agrawal Traders se 5000 ka maal udhaar', ask: '' };
    const before = server.getState().customers.length;
    await inbound(server, lib, wmsg(OWNER, { audioMessage: { mimetype: 'audio/ogg', ptt: true } }));
    assert.equal(server.getState().customers.length, before);
    assert.ok((server.getState().supplies || []).some((k) => /Agrawal/.test(k.name) && k.amount === 5000));
  } finally { server.close(); }
});
