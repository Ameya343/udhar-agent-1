// Udhaar Agent: one shop's agent as a small web server. Zero dependencies (Node 18+).
// One instance = one shop. On Agent37 each shop gets its own sandbox running this file on port 8000.
//
// Environment:
//   PORT                   default 8000
//   SHOP                   demo shop to seed: gupta | balaji | nayi (empty khata) (default gupta)
//   DATA_DIR               where the shop's khata is saved (default ./data)
//   AGENT37_LLM_PROXY_URL  OpenAI-compatible LLM router; Agent37 sets this on every instance
//   AGENT37_MANAGED_TOKEN  bearer token for that router; Agent37 sets it and renews it on restart
//   LLM_MODEL              optional model id for the router; unset = the router's default model
//   LLM_TIMEOUT_MS         default 8000; after this the offline rules answer instead
//   LLM_BASE_URL, LLM_API_KEY, LLM_BASE_TIMEOUT_MS, ROUTER_MODEL, LLM_JSON_MODE
//                          optional first model (any OpenAI-compatible endpoint, e.g. an open-source model on vLLM);
//                          with LLM_BASE_URL set, LLM_MODEL is that endpoint's model and the router is the fallback: see server/llm.js
//   REAL_CLOCK             1 = the agent's own scheduler: each new calendar day it runs the morning reminders,
//                          and at EVENING_HOUR (default 21) it sends the evening summary and cash batch
//   SHOP_CITY              optional: the shop's town for the AI's context (e.g. Nagpur); kept in the saved khata
//   OTHER_SHOPS            optional "Name|https://url,Name|https://url" for the shop switcher
//   TWILIO_*, OWNER_WHATSAPP, PUBLIC_URL, STT_*   real WhatsApp and voice notes: see server/whatsapp.js
//   WA_PROVIDER, META_*    twilio (default), meta (WhatsApp Cloud API, webhook /meta/webhook) or web (a linked device on
//                          an ordinary number): see server/whatsapp.js and server/wa-web.js
//   LINK_KEY               the secret for GET /link?key=..., where the shop's WhatsApp number is linked by QR (any provider)
//   ACT_LIMIT_PER_MIN      default 30: /api/act calls per minute per visitor IP (the public demo URL is open to anyone)
//   ADMIN_KEY              optional: on a live shop (REAL_CLOCK=1) "reset", "next day" and "close day" from the public page
//                          need the header x-admin-key with this value; calls from the instance itself always work
//   WA_REPLY_TWIML         1 = answer the WhatsApp sender inside the webhook reply (TwiML) instead of the Messages API
//   UDHAAR_ENV_FILE        optional KEY=value file read once at startup (default /home/node/udhaar.env).
//                          Agent37 cannot pass env vars to an instance, so keys go in this file instead.
//                          A variable already set in the real environment wins over the file.
//
// Without the LLM variables, or when the LLM call fails, the offline Hinglish rule parser answers.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const C = require('../core/agent-core.js');
const { createWhatsapp, parseMetaWebhook } = require('./whatsapp.js');
const { createWebTransport } = require('./wa-web.js');
const { createBrain } = require('./brain.js');
const { createFileStore, openStore } = require('./store.js');

const ROOT = path.join(__dirname, '..');
const MAX_BODY = 16 * 1024;
const MAX_META_BODY = 256 * 1024; // a Cloud API webhook can batch several messages

function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function parseOtherShops(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, url] = s.split('|').map((x) => (x || '').trim());
    return /^https?:\/\//.test(url || '') ? { name, url } : null;
  }).filter(Boolean);
}

function createServer(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const shopId = C.DEMO_SHOPS[env.SHOP] ? env.SHOP : 'gupta';
  C.FEATURES.vouch = env.FEATURE_VOUCH === '1'; // naye log (vouching) is off for now
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const others = parseOtherShops(env.OTHER_SHOPS);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const today = opts.today || localToday;

  const store = opts.store || createFileStore(dataDir, shopId);
  let state = store.load();
  if (!state || !state.shop) { state = C.freshShop(shopId, today()); save(); }
  // a khata saved before wholesalers existed gets the shop's demo wholesalers once; nothing else in it changes
  if (!state.wsSeeded) { const added = C.seedWholesalers(state, shopId); state.wsSeeded = true; if (added.length) console.log('Added wholesalers: ' + added.join(', ')); save(); }
  if (env.SHOP_CITY && state.shop.city !== env.SHOP_CITY) { state.shop.city = String(env.SHOP_CITY).slice(0, 60); save(); } // the AI is told where the shop is

  function save() { store.save(state); }

  // The linked-device transport exists whenever it is chosen or a LINK_KEY is set, so the number can be linked
  // (and stay linked) before the switch; its messages are answered only with WA_PROVIDER=web.
  const webOn = env.WA_PROVIDER === 'web';
  let wa = null;
  const web = webOn || env.LINK_KEY ? (opts.webTransport || createWebTransport)({
    authDir: env.WA_WEB_AUTH_DIR || path.join(dataDir, 'wa-web-auth'), keepAlive: webOn, maxPerHour: +env.WA_WEB_MAX_PER_HOUR || 30,
    loadLib: opts.waWebLib ? () => Promise.resolve(opts.waWebLib) : () => import('@whiskeysockets/baileys'),
    sleep: opts.sleep, now: opts.now,
    onMessage: (m) => {
      if (!wa.webReady) return; // linked early, still on Twilio / Meta: the linked number's chats are left alone
      serial(() => wa.handleWeb(m, act, () => state, save)).then(() => save(), (e) => { wa.stats.lastError = String(e.message || e).slice(0, 200); });
    }
  }) : null;
  wa = createWhatsapp({ env, fetch: fetchImpl, getState: () => state, now: opts.now, web });

  // The model chain (LLM_BASE_URL first if set, then the Agent37 router, then the rules): see server/llm.js and server/brain.js.
  const brain = createBrain({ env, fetch: fetchImpl, getState: () => state });
  const llm = brain.llm;
  const engine = {
    llm: llm.enabled, model: llm.describe(),
    get lastError() { return llm.stats.lastError; }, get llmCalls() { return llm.stats.calls; }, get llmFallbacks() { return llm.stats.fallbacks; }
  };

  function snapshot(extra) {
    return Object.assign({
      state, dashboard: C.dashboard(state, 30), shopId,
      engine: { llm: engine.llm, model: engine.model, lastError: engine.lastError, whatsapp: wa.stats.enabled },
      others
    }, extra || {});
  }

  function pageHtml() {
    const html = fs.readFileSync(path.join(ROOT, 'dist/udhaar-agent-standalone.html'), 'utf8');
    const cfg = '<script>window.UDHAAR_SERVER=' + JSON.stringify({ shopId, others }).replace(/</g, '\\u003c') + ';</script>';
    return html.replace('<body>', '<body>\n' + cfg);
  }

  function send(res, code, body, type) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  }

  function readBody(req, max, raw) {
    max = max || MAX_BODY;
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      // Past the limit, keep draining (so the client still gets the 413) but stop keeping bytes.
      req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
      req.on('end', () => { if (size > max) return reject(Object.assign(new Error('body too large'), { code: 413 })); const b = Buffer.concat(chunks); resolve(raw ? b : b.toString('utf8')); });
      req.on('error', reject);
    });
  }

  // One action at a time, so two quick taps can't interleave on the same khata.
  let queue = Promise.resolve();
  function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

  async function act(action, args) {
    if (action === 'reset') { state = C.freshShop(shopId, today()); save(); return snapshot({ freshTxn: null }); }
    if (C.ACTIONS.indexOf(action) < 0) throw Object.assign(new Error('unknown action'), { code: 400 });
    const a = Object.assign({}, args);
    delete a.intent; delete a.now; // never trust an intent (or a clock) from the browser
    const heard = typeof a.heard === 'string' && a.heard ? a.heard.slice(0, 500) : null; // a voice note's own words, in its own script
    delete a.heard;
    if (action === 'owner' && !C.looksLikeUpiSms(String(a.text || ''))) a.intent = await brain.understandOwner(String(a.text || '').slice(0, 500), { heard });
    if (action === 'customer' && a.text) { const ci = await brain.understandCustomer(String(a.text).slice(0, 500), String(a.custId || ''), { heard, source: a.source === 'voice' ? 'voice' : 'text' }); if (ci) a.intent = ci; }
    const from = state.messages.length;
    let out;
    try { out = C.runAction(state, action, a); } catch (e) { throw Object.assign(e, { code: 400 }); }
    await brain.translateOut(state, from); // each customer reads the agent in their own language
    save();
    return snapshot({ freshTxn: out.freshTxn, result: out.result });
  }

  // A small per-visitor rate limit for the routes that change the khata or spend AI calls. The page itself stays open
  // (it is a public demo); this only stops one visitor from hammering the shop. Local calls (no proxy) are not limited.
  const limits = { '/api/act': [+env.ACT_LIMIT_PER_MIN || 30, 60e3] };
  const hits = new Map();
  const LOCKED = new Set(['reset', 'nextDay', 'closeDay']);
  const local = (req) => !req.headers['x-forwarded-for'] && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const sameKey = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b)); return x.length === y.length && require('crypto').timingSafeEqual(x, y); };
  function limited(req, route) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.socket.remoteAddress || '';
    if (!fwd && /^(::1|127\.|::ffff:127\.)/.test(ip)) return false;
    const [max, windowMs] = limits[route], key = route + ' ' + ip, now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return true; }
    recent.push(now); hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && limits[url.pathname] && limited(req, url.pathname)) return send(res, 429, { error: 'too many requests, try again in a minute' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, shop: shopId, llm: engine.llm, scheduler: env.REAL_CLOCK === '1', llmCalls: engine.llmCalls, llmFallbacks: engine.llmFallbacks, ai: llm.health(),
        whatsapp: { provider: wa.provider, metaWebhook: !!env.META_WA_VERIFY_TOKEN, enabled: wa.stats.enabled, sending: wa.stats.sending, voice: wa.stats.stt, voiceProvider: wa.stats.sttProvider || null, voiceNotes: wa.stats.voiceNotes, received: wa.stats.received, sent: wa.stats.sent, failed: wa.stats.failed, lastError: wa.stats.lastError,
          web: web ? web.status() : null } });
      if (req.method === 'GET' && url.pathname === '/link') {
        // the shop number's QR: whoever sees it can link the number, so the key is required and checked in constant time
        if (!env.LINK_KEY || !web || !sameKey(url.searchParams.get('key'), env.LINK_KEY)) return send(res, 403, { error: 'forbidden' });
        await web.start();
        res.setHeader('referrer-policy', 'no-referrer');
        return send(res, 200, linkPage(web, state, webOn), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/meta/webhook') {
        // Meta's subscribe handshake; answers whenever META_WA_VERIFY_TOKEN is set, so the webhook can be saved before the switch
        const challenge = wa.metaVerify(url.searchParams);
        console.log('meta webhook: verify ' + (challenge === null ? 'refused' : 'ok'));
        return challenge === null ? send(res, 403, { error: 'forbidden' }) : send(res, 200, challenge, 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/meta/webhook') {
        let raw;
        try { raw = await readBody(req, MAX_META_BODY, true); } catch (e) { return send(res, 413, { error: 'body too large' }); }
        if (!wa.metaSignatureOk(raw, req.headers['x-hub-signature-256'])) { console.log('meta webhook: bad signature'); return send(res, 403, { error: 'bad signature' }); }
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad JSON' }); }
        send(res, 200, 'ok', 'text/plain; charset=utf-8'); // Meta wants a quick 200; the work happens after
        const msgs = parseMetaWebhook(body);
        if (!msgs.length) return; // delivery statuses and other events
        if (!wa.metaReady) { console.log('meta webhook: ' + msgs.length + ' message(s) ignored (WA_PROVIDER is not meta, or META_WA_TOKEN / META_WA_PHONE_NUMBER_ID / OWNER_WHATSAPP missing)'); return; }
        for (const m of msgs) {
          console.log('meta webhook: ' + m.type + ' message ' + String(m.id).slice(-8) + ' accepted');
          serial(() => wa.handleMeta(m, act, () => state, save)).then(() => save(), (e) => { wa.stats.lastError = String(e.message || e).slice(0, 200); });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/whatsapp') {
        if (!wa.twilioReady) { console.log('whatsapp webhook: hit while Twilio WhatsApp is off (provider ' + wa.provider + ')'); return send(res, 404, { error: 'not found' }); }
        let raw;
        try { raw = await readBody(req); } catch (e) { return send(res, 413, { error: 'body too large' }); }
        const params = Object.fromEntries(new URLSearchParams(raw));
        if (!wa.verify(req, params)) { console.log('whatsapp webhook: bad signature (url ' + (req.headers['x-forwarded-proto'] || '') + '://' + req.headers.host + req.url + ')'); return send(res, 403, { error: 'bad signature' }); }
        console.log('whatsapp webhook: message ' + String(params.MessageSid || '').slice(0, 8) + '… accepted');
        if (env.WA_REPLY_TWIML !== '1') {
          // Answer Twilio at once; replies go out through the API, so a slow voice note never times the webhook out.
          send(res, 200, wa.twiml([]), 'text/xml');
          serial(() => wa.handle(params, act, () => state, save)).then(() => save(), (e) => { wa.stats.lastError = String(e.message || e).slice(0, 200); });
          return;
        }
        // WA_REPLY_TWIML=1 (Sandbox on newer accounts): the sender's answer goes back in this webhook's TwiML (Twilio
        // waits 15 s); messages for anyone else, and anything later than 12 s, go out through the Messages API.
        let reply = Promise.resolve([]);
        const job = serial(() => { const h = wa.handleForReply(params, act, () => state, save, +env.WA_REPLY_WAIT_MS || 12000); reply = h.replied; return h.done; });
        job.then(() => save(), (e) => { wa.stats.lastError = String(e.message || e).slice(0, 200); });
        const msgs = await Promise.race([job.then(() => reply, () => reply), new Promise((r) => setTimeout(r, (+env.WA_REPLY_WAIT_MS || 12000) + 500)).then(() => reply)]);
        return send(res, 200, wa.twiml(msgs), 'text/xml');
      }
      if (req.method === 'GET' && url.pathname.startsWith('/pay/')) {
        const html = wa.payPage(state, decodeURIComponent(url.pathname.slice(5)));
        save(); // keeps the pay-link secret once made
        return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && /^\/media\/[0-9a-f]{24}\.mp3$/.test(url.pathname)) {
        const buf = wa.getMedia(url.pathname.slice(7, 31));
        if (!buf) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(buf);
      }
      if (req.method === 'GET' && url.pathname === '/join') {
        const html = wa.joinPage(state);
        return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());
      if (req.method === 'POST' && url.pathname === '/api/act') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
        if (+req.headers['content-length'] > MAX_BODY) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'body too large' }); }
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body too large' : 'bad JSON' }); }
        const action = String(body.action || '');
        // a live shop's khata and clock belong to the shop: a visitor on the public link can try everything else,
        // but cannot wipe the khata or move its day
        if (LOCKED.has(action) && env.REAL_CLOCK === '1' && !local(req) && !(env.ADMIN_KEY && sameKey(req.headers['x-admin-key'], env.ADMIN_KEY)))
          return send(res, 403, { error: 'locked', message: 'Yeh asli dukaan ka khata hai: "' + (action === 'reset' ? 'Demo dobara shuru' : action === 'nextDay' ? 'Agle din' : 'Dukaan band') + '" yahan band hai. Baaki sab aazmaiye 🙏' });
        const out = await serial(async () => {
          const from = state.messages.length, before = state;
          const r = await act(action, body.args || {});
          // customers on WhatsApp get what the owner did on the web page; the owner already sees it here
          if (state === before) { wa.deliver(state, from, null, { skipOwner: true }); save(); }
          return r;
        });
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e.code >= 400 && e.code < 500 ? e.code : 500;
      return send(res, code, { error: code === 500 ? 'server error' : e.message });
    }
  });
  // The agent's own scheduler. The demo's "Agle din" button only moves the shop's clock forward,
  // so the real date never pulls the khata backwards.
  const evening = +env.EVENING_HOUR || 21;
  const hourNow = opts.hour || (() => new Date().getHours());
  function tick() {
    const ran = [];
    return serial(async () => {
      const now = today();
      const from = state.messages.length;
      for (let i = 0; i < 31 && state.today < now; i++) { C.runAction(state, 'nextDay'); ran.push('nextDay'); }
      if (hourNow() >= evening && state.eveningSentFor !== state.today && state.today === now) { C.runAction(state, 'closeDay'); ran.push('closeDay'); }
      if (ran.length) { await brain.translateOut(state, from); wa.deliver(state, from); save(); }
      return ran;
    });
  }
  let timer = null;
  if (env.REAL_CLOCK === '1') { timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000); timer.unref(); server.on('close', () => clearInterval(timer)); }
  server.tick = tick;
  server.getState = () => state;
  server.engine = engine;
  server.brain = brain;
  server.whatsapp = wa;
  server.web = web;
  if (web && webOn) web.start();
  server.on('close', () => { if (web) web.stop(); store.close().catch(() => {}); });
  server.idle = () => queue.then(() => wa.idle()).then(() => web && web.idle());
  return server;
}

/** The page the owner opens to link the shop's WhatsApp number: a QR while waiting, the status after. Refreshes itself. */
function linkPage(web, state, active) {
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = web.status(), qrText = web.qr();
  let body;
  if (st.state === 'connected') {
    body = '<p class="ok">✅ Jud gaya' + (st.number ? ' (' + esc(st.number) + ')' : '') + '</p>' +
      (active ? '<p>WhatsApp isi number se chal raha hai.</p>' : '<p>Number jud gaya hai, par messages abhi purane tareeke (Twilio) se ja rahe hain. Badalne ke liye <b>WA_PROVIDER=web</b> likh kar dukaan restart karein.</p>');
  } else if (st.state === 'qr' && qrText) {
    const qr = require('../vendor/qrcode-generator.js')(0, 'L');
    qr.addData(qrText); qr.make();
    body = '<p class="wait">⏳ Scan ka intezaar</p><div class="qr">' + qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }) + '</div>' +
      '<ol><li>Dukaan wale phone par WhatsApp kholiye</li><li>⋮ (ya Settings) → <b>Linked devices</b> → <b>Link a device</b></li><li>Is QR ko scan kijiye</li></ol>';
  } else if (st.state === 'logged_out') {
    body = '<p class="bad">Number hata diya gaya (logged out). Naya QR aa raha hai…</p>';
  } else {
    body = '<p class="wait">⏳ WhatsApp se jud rahe hain… (' + esc(st.state) + ')</p>';
  }
  return '<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<meta http-equiv="refresh" content="' + (st.state === 'connected' ? 30 : 5) + '"><title>WhatsApp jodiye</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#1d1b16;margin:0;padding:24px 16px;display:flex;justify-content:center}main{max-width:420px;width:100%;text-align:center}' +
    'h1{font-size:22px;margin:0 0 6px}p,li{color:#5b564b;line-height:1.5}ol{text-align:left}.ok{color:#1f7a4d;font-size:20px;font-weight:700}.bad{color:#a3342b;font-weight:600}.wait{font-weight:600}' +
    '.qr svg{width:100%;max-width:320px;height:auto;background:#fff;padding:12px;border-radius:12px}.note{font-size:13px;color:#8a8478}</style></head><body><main>' +
    '<h1>' + esc(state.shop.name) + ': WhatsApp jodiye</h1>' + body +
    '<p class="note">Yeh page har kuch second mein apne aap naya hota hai. Yeh link kisi aur ko mat bhejiye.</p></main></body></html>';
}

// Reads KEY=value lines (blank lines and # comments skipped, optional quotes stripped) into env,
// without overriding variables that are already set. Returns the names it set; a missing file is fine.
function loadEnvFile(file, env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const set = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    if (env[m[1]] === undefined || env[m[1]] === '') { env[m[1]] = v; set.push(m[1]); }
  }
  return set;
}

module.exports = { createServer, loadEnvFile };

if (require.main === module) {
  const envFile = process.env.UDHAAR_ENV_FILE || '/home/node/udhaar.env';
  const fromFile = loadEnvFile(envFile, process.env);
  if (fromFile.length) console.log('Read ' + fromFile.length + ' setting(s) from ' + envFile + ': ' + fromFile.join(', '));
  const port = +process.env.PORT || 8000;
  const shopId = C.DEMO_SHOPS[process.env.SHOP] ? process.env.SHOP : 'gupta';
  openStore(process.env, path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')), shopId).then((store) => {
  createServer({ store }).listen(port, '0.0.0.0', () => {
    console.log('Udhaar Agent (' + (process.env.SHOP || 'gupta') + ') on :' + port + ', AI chain: ' + [process.env.LLM_BASE_URL ? 'custom' : '', process.env.AGENT37_LLM_PROXY_URL ? 'router' : ''].filter(Boolean).concat('rules').join(' -> '));
  });
}, (e) => { console.error('Storage failed to start: ' + e.message); process.exit(1); });
}
