// Real WhatsApp through Meta's Cloud API (WA_PROVIDER=meta): handshake, signed webhooks, the same handler as Twilio,
// the 24h window (free text inside, template outside), and the exact Graph API payloads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/server.js');
const { metaSignature, parseMetaWebhook, createWhatsapp } = require('../server/whatsapp.js');
const C = require('../core/agent-core.js');

const TODAY = '2026-10-08';
const OWNER = '919800000001', JUDGE = '919812345678';
const PHONE_ID = '1234567890';
const HOUR = 60 * 60 * 1000;
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }

// Stands in for the Graph API (and a speech-to-text server and ElevenLabs): records every call.
function fakeGraph(opts) {
  opts = opts || {};
  const sent = [], calls = [], uploads = [];
  const f = async (url, init) => {
    url = String(url); init = init || {}; calls.push({ url, init });
    if (url.endsWith('/' + PHONE_ID + '/messages')) {
      if (opts.sendFail) return new Response(JSON.stringify({ error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030, fbtrace_id: 'AbC' } }), { status: 400 });
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.x' }] }), { status: 200 });
    }
    if (url.endsWith('/' + PHONE_ID + '/media')) { uploads.push(init.body); return new Response(JSON.stringify({ id: 'media-up-1' }), { status: 200 }); }
    if (/\/v24\.0\/media-in-1$/.test(url)) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'audio/ogg', file_size: 20 }), { status: 200 });
    if (url.startsWith('https://lookaside.fbsbx.com/')) return new Response(Buffer.from('OggS fake audio'), { status: 200 });
    if (url.includes('/v1/text-to-speech/')) return new Response(Buffer.from('ID3 fake mp3'), { status: 200 });
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: opts.heard || '' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  f.sent = sent; f.calls = calls; f.uploads = uploads;
  f.to = (num) => sent.filter((s) => s.to === num);
  f.texts = (num) => f.to(num).filter((s) => s.type === 'text').map((s) => s.text.body);
  f.clear = () => { sent.length = 0; uploads.length = 0; };
  return f;
}

function metaServer(extraEnv, fetchOpts) {
  const fetch = fakeGraph(fetchOpts);
  const clock = { t: Date.parse('2026-10-08T10:00:00Z') };
  const env = Object.assign({
    SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-meta-')),
    WA_PROVIDER: 'meta', META_WA_TOKEN: 'EAAtest', META_WA_PHONE_NUMBER_ID: PHONE_ID, META_WA_VERIFY_TOKEN: 'verify-me-123',
    OWNER_WHATSAPP: '+' + OWNER
  }, extraEnv || {});
  const server = createServer({ env, today: () => TODAY, fetch, now: () => clock.t });
  return { server, fetch, clock };
}

// A Cloud API webhook body carrying one message.
function body(from, msg, name) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: name || 'Someone' }, wa_id: from }],
      messages: [Object.assign({ from, id: 'wamid.' + Math.random().toString(16).slice(2), timestamp: '1760000000' }, msg)]
    } }] }]
  };
}
const text = (t) => ({ type: 'text', text: { body: t } });

async function post(base, server, payload, headers) {
  const raw = JSON.stringify(payload);
  const r = await fetch(base + '/meta/webhook', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: raw });
  await server.idle();
  return r;
}

test('verify handshake: the right token echoes hub.challenge, anything else is 403; works before WA_PROVIDER=meta', async () => {
  const plain = createServer({ env: { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-meta-')), META_WA_VERIFY_TOKEN: 'verify-me-123' }, today: () => TODAY });
  const base = await listen(plain);
  try {
    let r = await fetch(base + '/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=123');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '123');
    r = await fetch(base + '/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123');
    assert.equal(r.status, 403);
    r = await fetch(base + '/meta/webhook?hub.mode=unsubscribe&hub.verify_token=verify-me-123&hub.challenge=123');
    assert.equal(r.status, 403);
    // Twilio stays the provider: a Meta message is acknowledged but not acted on
    r = await post(base, plain, body(OWNER, text('Rohit 500 udhaar')));
    assert.equal(r.status, 200);
    assert.equal(plain.getState().txns.length, 0);
    assert.equal((await (await fetch(base + '/healthz')).json()).whatsapp.provider, 'twilio');
  } finally { plain.close(); }
  // no verify token configured: never verifies
  const none = createServer({ env: { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-meta-')) }, today: () => TODAY });
  const b2 = await listen(none);
  try { assert.equal((await fetch(b2 + '/meta/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 403); } finally { none.close(); }
});

test('parsing: text, voice, button and list replies come through; statuses are skipped', () => {
  const b = body(JUDGE, text('cash de diya'), 'Rohit');
  b.entry[0].changes[0].value.messages.push(
    { from: JUDGE, id: 'w2', type: 'audio', audio: { id: 'media-in-1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { from: JUDGE, id: 'w3', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Haan' } } },
    { from: JUDGE, id: 'w4', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'g', title: 'Galat' } } },
    { from: JUDGE, id: 'w5', type: 'button', button: { text: 'Haan', payload: 'HAAN' } });
  b.entry.push({ id: 'WABA', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.s', status: 'delivered', recipient_id: JUDGE }] } }] });
  const m = parseMetaWebhook(b);
  assert.deepEqual(m.map((x) => [x.from, x.type, x.text]), [[JUDGE, 'text', 'cash de diya'], [JUDGE, 'audio', ''], [JUDGE, 'interactive', 'Haan'], [JUDGE, 'interactive', 'Galat'], [JUDGE, 'button', 'Haan']]);
  assert.equal(m[0].name, 'Rohit');
  assert.deepEqual(m[1].audio, { id: 'media-in-1', mime: 'audio/ogg; codecs=opus' });
  assert.deepEqual(parseMetaWebhook({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] }), []);
});

test('inbound text goes through the same handler as Twilio: join, item-wise bill, haan, cash, owner confirms', async () => {
  const { server, fetch: g } = metaServer();
  const base = await listen(server);
  try {
    // owner writes first (opens the owner's 24h window)
    await post(base, server, body(OWNER, text('aaj ka hisaab'), 'Owner'));
    g.clear();

    // a new number says hi and becomes a customer under its WhatsApp name
    let r = await post(base, server, body(JUDGE, text('hi'), 'Rohit Sharma'));
    assert.equal(r.status, 200);
    assert.match(g.texts(JUDGE)[0], /Namaste Rohit Sharma 🙏 Aap .* se jud gaye/);
    assert.match(g.texts(OWNER).join('\n'), /Rohit Sharma/);
    const rohit = server.getState().customers.find((c) => c.phone === '9812345678');
    assert.ok(rohit && rohit.wa);
    g.clear();

    // the owner approves the guest and dictates the bill
    await post(base, server, body(OWNER, text('ok')));
    await post(base, server, body(OWNER, text('Rohit ji cheeni 2 kilo 90, tel 1 litre 180')));
    const bill = g.texts(JUDGE).join('\n');
    assert.match(bill, /Cheeni 2 kilo = ₹90/i);
    assert.match(bill, /₹270/);
    g.clear();

    // an interactive button reply "Haan" is the same one-word answer
    await post(base, server, body(JUDGE, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'y', title: 'Haan' } } }));
    assert.match(g.texts(JUDGE)[0], /sahi bataya/);
    g.clear();

    await post(base, server, body(JUDGE, text('cash de diya')));
    assert.match(g.texts(JUDGE)[0], /₹270 cash note kar liya/);
    assert.match(g.texts(OWNER).pop(), /⏳ Rohit Sharma: ₹270 cash/);
    g.clear();
    await post(base, server, body(OWNER, text('haan')));
    assert.match(g.texts(OWNER)[0], /₹270 cash jama/);
    assert.equal(C.balance(server.getState(), rohit.id), 0);

    // Meta redelivers a message it is unsure about: the same id is acted on once
    const again = body(OWNER, text('Pappu 100 udhaar'));
    await post(base, server, again);
    await post(base, server, again);
    assert.equal(server.getState().txns.filter((t) => t.amount === 100).length, 1);

    // a delivery status alone changes nothing
    const n = server.getState().messages.length;
    r = await post(base, server, { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read', recipient_id: JUDGE }] } }] }] });
    assert.equal(r.status, 200);
    assert.equal(server.getState().messages.length, n);
    // the Twilio webhook is off while Meta is the provider
    assert.equal((await fetch(base + '/whatsapp', { method: 'POST', body: 'a=b' })).status, 404);
  } finally { server.close(); }
});

test('signature: with META_APP_SECRET only correctly signed bodies are accepted', async () => {
  const { server, fetch: g } = metaServer({ META_APP_SECRET: 'app-secret' });
  const base = await listen(server);
  try {
    const p = body(OWNER, text('Rohit 500 udhaar'));
    let r = await post(base, server, p, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
    assert.equal(r.status, 403);
    r = await post(base, server, p);
    assert.equal(r.status, 403);
    assert.equal(server.getState().txns.length, 0);
    assert.equal(g.sent.length, 0);
    r = await post(base, server, p, { 'x-hub-signature-256': metaSignature('app-secret', JSON.stringify(p)) });
    assert.equal(r.status, 200);
    assert.equal(server.getState().txns.length, 1);
  } finally { server.close(); }
  assert.match(metaSignature('k', 'abc'), /^sha256=[0-9a-f]{64}$/);
});

test('24h window: free text inside, the template outside (once per 12h for hello_world), and back to text after a reply', async () => {
  const { server, fetch: g, clock } = metaServer();
  const base = await listen(server);
  try {
    await post(base, server, body(OWNER, text('Pappu 200 udhaar')));
    assert.equal(g.to(OWNER)[0].type, 'text');
    g.clear();

    // 25 hours later the scheduler's evening summary is business-initiated: template, not text
    clock.t += 25 * HOUR;
    const st = server.getState();
    server.whatsapp.deliver(st, st.messages.length, ['Evening summary one', 'Evening summary two']);
    await server.idle();
    assert.deepEqual(g.to(OWNER).map((s) => s.type), ['template']);
    assert.deepEqual(g.to(OWNER)[0].template, { name: 'hello_world', language: { code: 'en_US' } });
    assert.equal(server.whatsapp.stats.templateSent, 1);
    assert.equal(server.whatsapp.stats.windowSkipped, 1);
    g.clear();

    // the owner answers: the window is open again
    await post(base, server, body(OWNER, text('kaun kaun baaki')));
    assert.ok(g.to(OWNER).length > 0 && g.to(OWNER).every((s) => s.type === 'text'));
    // the last inbound time is kept in the saved khata, so a restart remembers it
    assert.equal(server.getState().waLastIn[OWNER], clock.t);
  } finally { server.close(); }

  // META_TEMPLATE_BODY_PARAM=1 with a custom template: each message rides in {{1}}, newlines flattened
  const wa = createWhatsapp({ env: { WA_PROVIDER: 'meta', META_WA_TOKEN: 't', META_WA_PHONE_NUMBER_ID: PHONE_ID, OWNER_WHATSAPP: '+' + OWNER, META_TEMPLATE_NAME: 'udhaar_update', META_TEMPLATE_LANG: 'hi', META_TEMPLATE_BODY_PARAM: '1' }, fetch: fakeGraph(), now: () => 1e12 });
  const t = wa.metaPayload(JUDGE, 'Baaki ₹270\nJawab dijiye');
  assert.deepEqual(t.template, { name: 'udhaar_update', language: { code: 'hi' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Baaki ₹270 | Jawab dijiye' }] }] });
  assert.equal(wa.inWindow(JUDGE), false);
  wa.noteInbound(JUDGE);
  assert.equal(wa.inWindow(JUDGE), true);
  assert.equal(wa.metaPayload(JUDGE, 'x').type, 'text');
  assert.equal(wa.metaPayload(JUDGE, '', 'media-1').type, 'audio');
});

test('send payload: POST graph.facebook.com/v24.0/{phone_number_id}/messages with the bearer token and a text body; errors are logged', async () => {
  const { server, fetch: g } = metaServer();
  const base = await listen(server);
  try {
    await post(base, server, body(OWNER, text('Pappu 200 udhaar')));
    const call = g.calls.find((c) => c.url.endsWith('/messages'));
    assert.equal(call.url, 'https://graph.facebook.com/v24.0/' + PHONE_ID + '/messages');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer EAAtest');
    assert.equal(call.init.headers['content-type'], 'application/json');
    const p = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(p).sort(), ['messaging_product', 'recipient_type', 'text', 'to', 'type']);
    assert.equal(p.messaging_product, 'whatsapp');
    assert.equal(p.to, OWNER); // digits with country code, no plus
    assert.equal(p.type, 'text');
    assert.equal(p.text.preview_url, false);
    assert.match(p.text.body, /Pappu/);
  } finally { server.close(); }

  const s2 = metaServer({ META_GRAPH_VERSION: 'v99.0' }, { sendFail: true });
  const b2 = await listen(s2.server);
  try {
    await post(b2, s2.server, body(OWNER, text('Pappu 200 udhaar')));
    assert.ok(s2.fetch.calls.some((c) => c.url === 'https://graph.facebook.com/v99.0/' + PHONE_ID + '/messages'));
    assert.match(s2.server.whatsapp.stats.lastError, /Meta HTTP 400 code 131030 .*not in allowed list.*trace AbC/);
    assert.ok(s2.server.whatsapp.stats.failed >= 1);
    // the khata entry is still written
    assert.equal(s2.server.getState().txns.length, 1);
  } finally { s2.server.close(); }
});

test('voice: an owner voice note is downloaded from the Graph media URL, transcribed and written; ElevenLabs bills are uploaded then sent as audio', async () => {
  const { server, fetch: g } = metaServer({ STT_URL: 'https://stt.example.org/v1', ELEVENLABS_API_KEY: 'el', WA_VOICE_REPLIES: '1' }, { heard: 'Rohit ji ne 2 kilo cheeni li 90 rupaye' });
  const base = await listen(server);
  try {
    await post(base, server, body(JUDGE, text('hi'), 'Rohit Sharma'));
    await post(base, server, body(OWNER, text('ok')));
    g.clear();
    await post(base, server, body(OWNER, { type: 'audio', audio: { id: 'media-in-1', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
    const mediaGet = g.calls.find((c) => c.url.endsWith('/v24.0/media-in-1'));
    assert.equal(mediaGet.init.headers.authorization, 'Bearer EAAtest');
    const dl = g.calls.find((c) => c.url.startsWith('https://lookaside.fbsbx.com/'));
    assert.equal(dl.init.headers.authorization, 'Bearer EAAtest');
    assert.ok(g.calls.some((c) => c.url.endsWith('/audio/transcriptions')));
    assert.match(g.texts(OWNER)[0], /🎙️ Suna: "Rohit ji ne 2 kilo cheeni li 90 rupaye"/);
    assert.ok(server.getState().txns.find((t) => t.amount === 90));
    // the customer is inside the window: the text bill, then the voice note by uploaded media id
    const toJudge = g.to(JUDGE);
    assert.equal(toJudge[0].type, 'text');
    const audio = toJudge.find((s) => s.type === 'audio');
    assert.deepEqual(audio && audio.audio, { id: 'media-up-1' });
    assert.equal(g.uploads.length, 1);
    assert.equal(g.uploads[0].get('messaging_product'), 'whatsapp');
    assert.equal(g.uploads[0].get('type'), 'audio/mpeg');
  } finally { server.close(); }
});
