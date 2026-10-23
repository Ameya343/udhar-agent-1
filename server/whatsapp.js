// Real WhatsApp for one shop, through Twilio (the WhatsApp Sandbox works for a demo; a WhatsApp Business number later).
//
// Inbound:  Twilio POSTs every message to /whatsapp. The owner's number talks to the agent (text or voice note);
//           any other number is a customer. A new number becomes a customer under its WhatsApp name.
// Outbound: every message the agent writes to the owner or to a customer is sent on WhatsApp, whether it came from
//           a WhatsApp message, the web page, or the scheduler. Customers get messages only after they wrote first.
//
// Environment:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   Twilio account (the token also checks that webhooks really come from Twilio)
//   TWILIO_WHATSAPP_FROM                    the shop's WhatsApp sender, e.g. whatsapp:+14155238886 (Sandbox)
//   OWNER_WHATSAPP                          the shop owner's own number, e.g. +919876543210
//   PUBLIC_URL                              this server's public https address (webhook signature check, pay links)
//   WA_JOIN_CODE                            Sandbox join words, e.g. "join shiny-tiger"; shown as a QR at /join
//   Voice notes are INPUT only by default: the owner or a customer speaks, the agent writes, the answer comes as text.
//   STT_URL, STT_KEY, STT_MODEL, STT_LANGUAGE   OpenAI-compatible speech-to-text for voice notes
//                                           (/audio/transcriptions; e.g. Whisper on a GPU).
//   ELEVENLABS_API_KEY                      without STT_URL, voice notes are transcribed by ElevenLabs Speech to Text
//   ELEVENLABS_STT_MODEL                    (default scribe_v1). Neither set = voice notes are refused politely.
//                                           STT_PROVIDER=off turns speech-to-text off.
//   WA_VOICE_REPLIES=1                      optional: customers ALSO get each bill and reminder as a Hindi voice note
//   ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL   (ElevenLabs text to speech, needs ELEVENLABS_API_KEY). Unset = text only.
//
// Second transport, Meta's WhatsApp Cloud API (chosen with WA_PROVIDER=meta; default twilio, unchanged):
//   META_WA_TOKEN, META_WA_PHONE_NUMBER_ID  access token and the shop number's Phone number ID (WhatsApp Manager)
//   META_WA_VERIFY_TOKEN                    any string; Meta sends it back on GET /meta/webhook (works with either provider)
//   META_APP_SECRET                         optional: checks X-Hub-Signature-256 on POST /meta/webhook
//   META_GRAPH_VERSION                      default v24.0
//   META_WABA_ID                            optional, shown on /healthz only
//   META_TEMPLATE_NAME, META_TEMPLATE_LANG  template for business-initiated sends outside the 24h window
//                                           (default hello_world / en_US). META_TEMPLATE_BODY_PARAM=1 puts the message
//                                           text into the template's {{1}} (for your own approved utility template).
//   META_WA_DISPLAY_NUMBER                  optional: the shop number (digits) for the /join QR
//   Inbound: Meta POSTs to /meta/webhook. Every message goes through the same handler as Twilio's.
//   Outbound: inside 24h of the person's last message, plain text (and voice notes); outside it, the template.
//
// Third transport, a linked device on an ordinary WhatsApp number (WA_PROVIDER=web): see server/wa-web.js.
//   Inbound comes from the linked session into the same handler; text always goes (no 24h window), voice notes go as
//   push-to-talk audio, and every send is slow and capped against bans. Link it first at /link?key=LINK_KEY.
'use strict';
const crypto = require('crypto');
const C = require('../core/agent-core.js');

const MAX_AUDIO = 16 * 1024 * 1024;
const digits = (s) => String(s || '').replace(/\D/g, '');
const phone10 = (s) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Twilio's request signature: HMAC-SHA1 of the full URL plus every POST field (sorted by name), base64. */
function twilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
function sameString(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Meta's request signature: "sha256=" + HMAC-SHA256 (hex) of the raw body with the app secret. */
function metaSignature(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')).digest('hex');
}

/**
 * The messages in one Cloud API webhook body, in a transport-neutral shape. Statuses (sent/delivered/read) are skipped.
 * { id, from: '919812345678', name, type, text, audio: { id, mime } | null }
 */
function parseMetaWebhook(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = {};
      for (const c of v.contacts || []) if (c && c.wa_id) names[digits(c.wa_id)] = c.profile && c.profile.name || '';
      for (const m of v.messages || []) {
        if (!m || !m.from) continue;
        const from = digits(m.from);
        let text = '', audio = null;
        if (m.type === 'text') text = (m.text && m.text.body) || '';
        else if (m.type === 'audio' || m.type === 'voice') { const a = m.audio || m.voice || {}; if (a.id) audio = { id: String(a.id), mime: a.mime_type || 'audio/ogg' }; }
        else if (m.type === 'interactive') { const i = m.interactive || {}; const r = i.button_reply || i.list_reply || {}; text = r.title || r.id || ''; }
        else if (m.type === 'button') text = (m.button && (m.button.text || m.button.payload)) || '';
        else if (m.type === 'image' || m.type === 'video' || m.type === 'document') text = ((m[m.type] || {}).caption) || '';
        out.push({ id: String(m.id || ''), from, name: names[from] || '', type: m.type, text: String(text), audio });
      }
    }
  }
  return out;
}

function createWhatsapp(o) {
  const env = o.env, fetchImpl = o.fetch;
  const now = o.now || Date.now;
  const provider = env.WA_PROVIDER === 'meta' ? 'meta' : env.WA_PROVIDER === 'web' ? 'web' : 'twilio';
  const web = provider === 'web' ? o.web || null : null; // the linked-device transport (wa-web.js)
  const meta = {
    token: env.META_WA_TOKEN || '', phoneId: env.META_WA_PHONE_NUMBER_ID || '', verifyToken: env.META_WA_VERIFY_TOKEN || '',
    appSecret: env.META_APP_SECRET || '', version: env.META_GRAPH_VERSION || 'v24.0', waba: env.META_WABA_ID || '',
    template: env.META_TEMPLATE_NAME || 'hello_world', lang: env.META_TEMPLATE_LANG || 'en_US', bodyParam: env.META_TEMPLATE_BODY_PARAM === '1',
    graph: (env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '')
  };
  const graphUrl = (p) => meta.graph + '/' + meta.version + '/' + p;
  const sid = env.TWILIO_ACCOUNT_SID || '', token = env.TWILIO_AUTH_TOKEN || '';
  const sender = env.TWILIO_WHATSAPP_FROM || '';
  const api = (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const owner = phone10(env.OWNER_WHATSAPP);
  const ownerTo = digits(env.OWNER_WHATSAPP);
  const sttUrl = (env.STT_URL || '').replace(/\/+$/, '');
  // Speech-to-text: an OpenAI-compatible STT_URL wins; otherwise ElevenLabs with the same key the shop already has.
  const sttProvider = env.STT_PROVIDER === 'off' ? null : sttUrl ? 'openai' : env.ELEVENLABS_API_KEY ? 'elevenlabs' : null;
  const elevenBase = (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const isMeta = provider === 'meta', isWeb = provider === 'web';
  const stats = {
    provider, enabled: !!(owner && (isWeb ? web : isMeta ? meta.token && meta.phoneId : token)),
    sending: isWeb ? !!web : isMeta ? !!(meta.token && meta.phoneId) : !!(sid && token && sender),
    stt: !!sttProvider, sttProvider, received: 0, sent: 0, failed: 0, lastError: null
  };
  if (isMeta) Object.assign(stats, { metaTemplate: meta.template, metaWaba: meta.waba || null, templateSent: 0, windowSkipped: 0 });

  // ---------------------------------------------------------------- 24h customer-service window (Meta)
  // Each number's last inbound time, kept in the shop's saved state so a restart does not forget it.
  const WINDOW = 24 * 60 * 60 * 1000 - 5 * 60 * 1000; // a few minutes' margin before Meta's 24 hours run out
  const TEMPLATE_GAP = 12 * 60 * 60 * 1000; // a contentless template (hello_world) goes at most once per 12h per number
  const lastIn = {}; // fallback when no state getter is given
  const templateAt = new Map();
  function inboundStore() { const s = o.getState && o.getState(); if (!s) return lastIn; if (!s.waLastIn) s.waLastIn = {}; return s.waLastIn; }
  function noteInbound(to) { if (to) inboundStore()[to] = now(); }
  function inWindow(to) { const t = inboundStore()[to]; return !!t && now() - t < WINDOW; }

  // ---------------------------------------------------------------- outbound
  let outQueue = Promise.resolve();
  // While a webhook is being answered, text for the person who wrote is collected and returned in the webhook's
  // TwiML reply instead of the Messages API: the Sandbox accepts a reply to an inbound message without a template
  // (the API answers 21654 "ContentSid Required" for Sandbox senders on newer accounts).
  let capture = null;
  function sendNow(to, body, mediaUrl) {
    if (capture && capture.open && to === capture.to && (body || mediaUrl)) { capture.msgs.push(mediaUrl ? { media: mediaUrl } : String(body).slice(0, 1590)); stats.sent++; return Promise.resolve(); }
    if (!stats.sending || !to) return Promise.resolve();
    if (isMeta) return metaSend(to, body, mediaUrl);
    if (isWeb) return web.send(to, { text: String(body).slice(0, 4000) }).then((ok) => { if (ok) { stats.sent++; return true; } stats.failed++; stats.lastError = web.status().lastError; return false; });
    const form = new URLSearchParams({ From: sender, To: 'whatsapp:+' + to });
    if (body) form.set('Body', String(body).slice(0, 1590));
    if (mediaUrl) form.set('MediaUrl', mediaUrl);
    return fetchImpl(api + '/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
      method: 'POST', body: form.toString(),
      headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }
    }).then(async (r) => {
      if (!r.ok) throw new Error('Twilio HTTP ' + r.status + ' ' + String(await r.text().catch(() => '')).slice(0, 160));
      stats.sent++;
      return true;
    }).catch((e) => {
      stats.failed++; stats.lastError = String(e.message || e).slice(0, 200);
      if (capture && capture.open && to !== capture.to && to !== ownerTo) capture.failed.push(to);
      return false;
    });
  }
  // ---------------------------------------------------------------- Meta Cloud API sends
  function graphError(status, text) {
    let e = null;
    try { e = JSON.parse(text).error; } catch (x) { e = null; }
    return 'Meta HTTP ' + status + (e ? ' code ' + e.code + (e.error_subcode ? '/' + e.error_subcode : '') + ' ' + String(e.message || '').slice(0, 140) + (e.fbtrace_id ? ' (trace ' + e.fbtrace_id + ')' : '') : ' ' + String(text || '').slice(0, 140));
  }
  async function graphPost(p, payload) {
    const isForm = payload instanceof FormData;
    const r = await fetchImpl(graphUrl(p), {
      method: 'POST', body: isForm ? payload : JSON.stringify(payload),
      headers: Object.assign({ authorization: 'Bearer ' + meta.token }, isForm ? {} : { 'content-type': 'application/json' })
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) throw new Error(graphError(r.status, text));
    try { return JSON.parse(text); } catch (e) { return {}; }
  }
  /** The JSON body for one message: free text inside the 24h window, else the template. Null = do not send. */
  function metaPayload(to, body, audioId) {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to) };
    if (inWindow(to)) {
      if (audioId) return Object.assign(base, { type: 'audio', audio: { id: audioId } });
      return Object.assign(base, { type: 'text', text: { preview_url: false, body: String(body).slice(0, 4096) } });
    }
    if (audioId) return null; // voice notes only inside the window; the text (or template) already went
    const template = { name: meta.template, language: { code: meta.lang } };
    if (meta.bodyParam) template.components = [{ type: 'body', parameters: [{ type: 'text', text: String(body).replace(/\s*\n+\s*/g, ' | ').replace(/\s{4,}/g, '   ').slice(0, 1000) }] }];
    return Object.assign(base, { type: 'template', template });
  }
  function metaSend(to, body, audioId) {
    const payload = metaPayload(to, body, audioId);
    if (!payload) return Promise.resolve();
    if (payload.type === 'template' && !meta.bodyParam) {
      const t = templateAt.get(to);
      if (t && now() - t < TEMPLATE_GAP) { stats.windowSkipped++; console.log('meta send: +' + to + ' outside 24h window, template already sent; message dropped'); return Promise.resolve(); }
      templateAt.set(to, now());
    }
    return graphPost(meta.phoneId + '/messages', payload).then(() => {
      stats.sent++;
      if (payload.type === 'template') { stats.templateSent++; console.log('meta send: +' + to + ' outside 24h window, sent template ' + meta.template); }
      return true;
    }).catch((e) => {
      stats.failed++; stats.lastError = String(e.message || e).slice(0, 200);
      console.log('meta send failed (+' + to + ', ' + payload.type + '): ' + stats.lastError);
      return false;
    });
  }
  /** A voice note through the Cloud API: upload the audio to /media, then send it by id. */
  async function metaVoice(to, buf) {
    if (!inWindow(to)) return;
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', 'audio/mpeg');
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'voice.mp3');
    const up = await graphPost(meta.phoneId + '/media', fd);
    if (!up.id) throw new Error('Meta media upload gave no id');
    await metaSend(to, '', up.id);
  }

  // In order, one after another, so a bill never arrives after its receipt.
  function queueSend(to, body) { outQueue = outQueue.then(() => sendNow(to, body)); return outQueue; }

  // ---------------------------------------------------------------- Hindi voice notes (ElevenLabs)
  // For customers who listen more than they read: the bill and the reminder also arrive as a short voice note in the
  // shop's name. The text always goes first; if the voice fails, the text alone is enough.
  const tts = { key: env.ELEVENLABS_API_KEY || '', voice: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM', model: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    api: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '') };
  // Replies are text only unless WA_VOICE_REPLIES=1: having an ElevenLabs key (used for speech-to-text) is not enough.
  stats.voiceNotes = !!(env.WA_VOICE_REPLIES === '1' && tts.key && (isMeta || isWeb || publicUrl));
  const media = new Map(); // id -> { buf, at }; kept an hour so Twilio can fetch it, never written to disk
  const MEDIA_TTL = 60 * 60 * 1000;
  function keepMedia(buf) {
    const now = Date.now();
    for (const [k, v] of media) if (now - v.at > MEDIA_TTL || media.size > 200) media.delete(k);
    const id = crypto.randomBytes(12).toString('hex');
    media.set(id, { buf, at: now });
    return id;
  }
  function getMedia(id) { const m = media.get(id); return m && Date.now() - m.at <= MEDIA_TTL ? m.buf : null; }
  const say = (n) => Math.round(n) + ' रुपये';
  const UNIT_WORD = { kg: 'kilo', g: 'gram', l: 'litre', ml: 'ml', pkt: 'packet', pc: '', pav: 'pav', dozen: 'dozen' };
  /** What the voice note says: short, in Hindi, in the shop's name. Null for messages that stay text only. */
  function voiceScript(state, m) {
    const c = state.customers.find((x) => x.id === m.to);
    if (!c) return null;
    const shop = state.shop.name, bal = Math.max(0, C.balance(state, c.id));
    if (m.kind === 'reminder' && m.amount > 0)
      return 'नमस्ते ' + c.name + '। ' + shop + ' से बोल रहे हैं। आपके खाते में ' + say(m.amount) + ' बाकी हैं। जब सुविधा हो, दुकान पर नकद या UPI से दे दीजिए। पैसे दे दिए हों तो "cash de diya" लिख दीजिए। धन्यवाद।';
    if (m.kind === 'statement') return 'नमस्ते ' + c.name + '। ' + shop + ' से। आपके खाते में ' + say(bal) + ' बाकी हैं। सही है तो "हाँ" लिखिए, गलत हो तो "गलत"।';
    if (m.kind === 'order-ask') {
      const o = (state.orders || []).find((x) => x.id === m.orderId);
      if (!o) return null;
      const items = o.lines.filter((l) => l.price != null).map((l) => l.name + (l.qty ? ' ' + l.qty + (l.unit ? ' ' + (UNIT_WORD[l.unit] || l.unit) : '') : '') + ', ' + say(l.price)).join('; ');
      return 'नमस्ते ' + c.name + '। ' + shop + ' से। आपका ऑर्डर: ' + items + '। कुल ' + say(o.amount) + '। उधार में लिखना हो तो "हाँ" लिखिए, नकद देंगे तो "नहीं"।';
    }
    if (m.kind === 'entry-check') {
      const t = state.txns.find((x) => x.id === m.txnId);
      if (!t) return null;
      const items = (t.lines || []).filter((l) => l.price > 0).map((l) => l.name + (l.qty ? ' ' + l.qty + (l.unit ? ' ' + (UNIT_WORD[l.unit] || l.unit) : '') : '') + ', ' + say(l.price)).join('; ');
      return 'नमस्ते ' + c.name + '। ' + shop + ' से। आज आपके खाते में ' + say(t.amount) + (t.type === 'credit' ? ' उधार' : ' जमा') + ' लिखे गए' + (items ? ': ' + items : '') +
        '। कुल बाकी ' + say(bal) + '। सही है तो "हाँ" लिखिए, गलत हो तो "गलत"।';
    }
    return null;
  }
  // A linked-device voice note (ptt) has to be Ogg Opus to play as a voice note on phones.
  async function speak(text) {
    const r = await fetchImpl(tts.api + '/v1/text-to-speech/' + encodeURIComponent(tts.voice) + '?output_format=' + (isWeb ? 'opus_48000_64' : 'mp3_44100_128'), {
      method: 'POST', headers: { 'xi-api-key': tts.key, 'content-type': 'application/json', accept: isWeb ? 'audio/ogg' : 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: tts.model })
    });
    if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  function queueVoice(to, script) {
    if (!stats.voiceNotes || !stats.sending || !script) return;
    outQueue = outQueue.then(async () => {
      try {
        if (isWeb) { const ok = await web.send(to, { audio: await speak(script), mimetype: 'audio/ogg; codecs=opus' }); if (ok) stats.voiceSent = (stats.voiceSent || 0) + 1; else stats.voiceFailed = (stats.voiceFailed || 0) + 1; return; }
        if (isMeta) { if (!inWindow(to)) return; await metaVoice(to, await speak(script)); stats.voiceSent = (stats.voiceSent || 0) + 1; return; }
        const id = keepMedia(await speak(script)); stats.voiceSent = (stats.voiceSent || 0) + 1; await sendNow(to, '', publicUrl + '/media/' + id + '.mp3');
      }
      catch (e) { stats.voiceFailed = (stats.voiceFailed || 0) + 1; stats.lastError = String(e.message || e).slice(0, 200); }
    });
  }

  function payToken(state, custId) {
    if (!state.paySecret) state.paySecret = crypto.randomBytes(16).toString('hex');
    return crypto.createHmac('sha256', env.PAY_SECRET || state.paySecret).update(custId).digest('hex').slice(0, 16);
  }
  function payUrl(state, custId) { return publicUrl ? publicUrl + '/pay/' + custId + '.' + payToken(state, custId) : null; }

  /** The WhatsApp version of a message: the same words, plus how to answer. */
  function waText(state, m) {
    let t = m.text;
    if ((m.kind === 'entry-check' && !m.list) || m.kind === 'statement') t += '\n\nJawab dijiye: *Haan* ya *Galat*'; // a list already ends with "haan / galat likhein"
    if (m.kind === 'consent-ask') t += '\n\nJawab dijiye: *Haan* ya *Nahi*';
    if (m.kind === 'reminder' && m.amount > 0) { const u = payUrl(state, m.to); if (u) t += '\nUPI se dena ho toh: ' + u; }
    return t;
  }
  function recipient(state, to, kind) {
    if (to === 'owner') return ownerTo || null;
    const w = (state.wholesalers || []).find((x) => x.id === to);
    if (w) return w.wa && w.phone ? (w.waTo || '91' + w.phone) : null; // a wholesaler, too, only after they wrote to the shop
    const c = state.customers.find((x) => x.id === to);
    if (c && c.optedOut && kind !== 'optout-ack') return null; // "nahi chahiye" / "band karo": only the one confirmation goes
    if (c && c.removed && kind === 'removed-ack' && c.phone) return c.waTo || '91' + c.phone; // the one short line to a removed number
    return c && !c.removed && c.wa && c.phone ? (c.waTo || '91' + c.phone) : null; // only numbers that wrote to us first
  }

  /**
   * Send everything the agent wrote since `from` (an index into state.messages), then, if the owner has cash claims
   * or "galat hai" questions waiting, ask about the oldest one (one at a time, answered with haan / nahi).
   */
  function deliver(state, from, pre, opts) {
    if (!stats.enabled) return;
    const skipOwner = !!(opts && opts.skipOwner); // the owner is looking at the web page already
    for (const t of pre || []) queueSend(ownerTo, t);
    const unsent = [];
    for (const m of state.messages.slice(from)) {
      if (m.from !== 'agent' || (skipOwner && m.to === 'owner')) continue;
      const to = recipient(state, m.to, m.kind);
      if (to && m.wsOrder) {
        // a stock order the owner approved: if WhatsApp refuses it (hourly cap, not linked), the owner hears so
        const name = ((state.wholesalers || []).find((x) => x.id === m.to) || {}).name || 'Wholesaler';
        outQueue = outQueue.then(() => sendNow(to, waText(state, m))).then((ok) => {
          if (ok !== false) return;
          const o = (state.wsOrders || []).find((x) => x.id === m.wsOrder);
          if (o && o.status === 'sent') { o.status = 'unsent'; o.why = 'send-failed'; }
          return sendNow(ownerTo, '⚠️ ' + name + ' ko order WhatsApp par nahi gaya (WhatsApp ne abhi roka). Thodi der baad dobara boliye, ya phone par bata dijiye.');
        });
      } else if (to) { queueSend(to, waText(state, m)); if (m.to !== 'owner') queueVoice(to, voiceScript(state, m)); }
      else if (m.to !== 'owner' && capture && capture.open) { const k = state.customers.find((x) => x.id === m.to); if (k) capture.skipped.push(k.name); }
      // a customer's list that cannot go out: the owner is told why, so nobody thinks the customer saw it
      if (!to && m.list && !skipOwner) {
        const k = state.customers.find((x) => x.id === m.to);
        if (k && k.phone && !k.removed) unsent.push(k.name + ' ko list WhatsApp par nahi gayi: ' + (k.optedOut ? 'unhone messages band kiye hain' : 'unhone abhi tak dukaan ke number par "hi" nahi bheja') + '. Sirf khate mein likha.');
      }
    }
    for (const u of unsent) queueSend(ownerTo, '⚠️ ' + u);
    const next = C.pendingClaims(state)[0];
    if (next && state.waAsked !== next.id && !skipOwner && !(state.ownerAsks || []).length) { // one question to the owner at a time
      state.waAsked = next.id;
      queueSend(ownerTo, '⏳ ' + C.claimLabel(state, next) + '\nJawab: *haan* ✅ ya *nahi* ❌' + (C.pendingClaims(state).length > 1 ? ' (' + C.pendingClaims(state).length + ' baaki)' : ''));
    }
  }

  // ---------------------------------------------------------------- voice notes
  async function twilioAudio(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)twilio\.com$/.test(u.hostname)) throw new Error('media not from Twilio');
    const r = await fetchImpl(url, { headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') } });
    if (!r.ok) throw new Error('media HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  // Cloud API media: GET /{media-id} gives a short-lived URL, which is fetched with the same token.
  async function metaAudio(id) {
    const r = await fetchImpl(graphUrl(encodeURIComponent(id)), { headers: { authorization: 'Bearer ' + meta.token } });
    const text = await r.text().catch(() => '');
    if (!r.ok) throw new Error(graphError(r.status, text));
    const j = JSON.parse(text || '{}');
    const u = new URL(String(j.url || ''));
    if (u.protocol !== 'https:' || !/(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/.test(u.hostname)) throw new Error('media not from Meta');
    if (+j.file_size > MAX_AUDIO) throw new Error('voice note too long');
    const m = await fetchImpl(u.href, { headers: { authorization: 'Bearer ' + meta.token } });
    if (!m.ok) throw new Error('media HTTP ' + m.status);
    return Buffer.from(await m.arrayBuffer());
  }
  /** audio: { url } (Twilio), { metaId } (Cloud API) or { web } (linked device), plus its type. */
  async function transcribe(audio, type) {
    if (!sttProvider) return null;
    const buf = audio.web ? Buffer.from(await web.download(audio.web)) : audio.metaId ? await metaAudio(audio.metaId) : await twilioAudio(audio.url);
    if (buf.length > MAX_AUDIO) throw new Error('voice note too long');
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: type || 'audio/ogg' }), 'voice.' + ((/audio\/(\w+)/.exec(type || '') || [])[1] || 'ogg'));
    if (sttProvider === 'elevenlabs') {
      fd.append('model_id', env.ELEVENLABS_STT_MODEL || 'scribe_v1');
      if (env.STT_LANGUAGE !== 'auto') fd.append('language_code', env.STT_LANGUAGE || 'hi');
      fd.append('tag_audio_events', 'false'); // no "(laughter)" / "[beep]" in the khata
      const e = await fetchImpl(elevenBase + '/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: fd });
      if (!e.ok) throw new Error('STT HTTP ' + e.status);
      const ej = await e.json();
      return String(ej.text || '').trim().slice(0, 500);
    }
    fd.append('model', env.STT_MODEL || 'whisper-1');
    if (env.STT_LANGUAGE !== 'auto') fd.append('language', env.STT_LANGUAGE || 'hi');
    // A Hinglish example nudges the model to write the way shopkeepers talk, in Roman letters.
    fd.append('prompt', 'Sharma ji ne cheeni 2 kilo 90, tel 180 liya, kal denge. Pappu 200 cash de gaya.');
    const headers = env.STT_KEY ? { authorization: 'Bearer ' + env.STT_KEY } : {};
    const s = await fetchImpl(sttUrl + '/audio/transcriptions', { method: 'POST', headers, body: fd });
    if (!s.ok) throw new Error('STT HTTP ' + s.status);
    const j = await s.json();
    return String(j.text || '').trim().slice(0, 500);
  }

  // ---------------------------------------------------------------- inbound
  /** GET /meta/webhook: the subscribe handshake. Returns the challenge to echo, or null (403). */
  function metaVerify(q) {
    if (!meta.verifyToken) return null;
    return q.get('hub.mode') === 'subscribe' && sameString(q.get('hub.verify_token'), meta.verifyToken) ? String(q.get('hub.challenge') || '') : null;
  }
  /** POST /meta/webhook: true when the body is signed with META_APP_SECRET (or no secret is set). */
  function metaSignatureOk(raw, header) {
    if (!meta.appSecret) return true;
    return sameString(header, metaSignature(meta.appSecret, raw));
  }

  /** True when the request really comes from Twilio. */
  function verify(req, params) {
    if (!token) return false;
    const url = (publicUrl || 'https://' + req.headers.host) + req.url;
    return sameString(req.headers['x-twilio-signature'], twilioSignature(token, url, params));
  }

  // The latest question this customer can answer with one word: an entry or monthly hisaab to check, or a lender's ask.
  function openQuestion(state, cust, answer) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.to !== cust.id || m.from !== 'agent') continue;
      if (m.kind === 'order-ask') { const o = (state.orders || []).find((x) => x.id === m.orderId); return o && o.status === 'ask' ? { kind: 'order', orderId: o.id } : null; }
      if (m.kind === 'consent-ask') return C.consentOf(state, cust.id).status === 'requested' ? { kind: 'consent' } : null;
      if (m.kind === 'entry-check' || m.kind === 'statement') {
        if (!m.answer || (m.answer === 'auto' && answer === 'no')) return { kind: 'check', msgId: m.id };
      }
    }
    return null;
  }

  /** One inbound Twilio message (the webhook's form fields). */
  function handle(params, act, getState, save) {
    const audio = +params.NumMedia > 0 && /^audio\//.test(params.MediaContentType0 || '') ? { url: params.MediaUrl0, type: params.MediaContentType0 } : null;
    return handleInbound({ from: digits(params.From), name: params.ProfileName, text: params.Body, audio }, act, getState, save);
  }
  /** One inbound Cloud API message, as parseMetaWebhook gives it. Same handler as Twilio's. */
  const seenMeta = new Set();
  function handleMeta(m, act, getState, save) {
    if (m.id) { if (seenMeta.has(m.id)) return Promise.resolve(); seenMeta.add(m.id); if (seenMeta.size > 1000) seenMeta.delete(seenMeta.values().next().value); }
    const audio = m.audio ? { metaId: m.audio.id, type: m.audio.mime } : null;
    return handleInbound({ from: m.from, name: m.name, text: m.text, audio }, act, getState, save);
  }
  /** One inbound linked-device message, as parseWebMessage gives it. Same handler again. */
  const seenWeb = new Set();
  function handleWeb(m, act, getState, save) {
    if (!isWeb) return Promise.resolve();
    if (m.id) { if (seenWeb.has(m.id)) return Promise.resolve(); seenWeb.add(m.id); if (seenWeb.size > 1000) seenWeb.delete(seenWeb.values().next().value); }
    return handleInbound({ from: m.from, name: m.name, text: m.text, audio: m.audio || null }, act, getState, save);
  }

  /**
   * One inbound WhatsApp message, whichever transport brought it: { from: digits with country code, name, text,
   * audio: null | { url, type } | { metaId, type } }. `act` is the server's action runner; the caller runs this one at a time.
   */
  async function handleInbound(msg, act, getState, save) {
    stats.received++;
    const from = phone10(msg.from), fromTo = digits(msg.from);
    if (!from || !stats.enabled) return;
    noteInbound(fromTo);
    const params = { From: fromTo, ProfileName: msg.name };
    let text = String(msg.text || '').trim().slice(0, 500);
    const audio = msg.audio || null;
    const pre = [];
    let state = getState();
    if (from === owner) state.ownerPhone = owner; // so a wholesaler can never be given the shop's own number
    let start = state.messages.length;

    // a wholesaler's number is the wholesaler (never a customer or a guest), checked before anything else
    const wsFrom = from !== owner ? (state.wholesalers || []).find((x) => x.phone === from) : null;
    const gone = from !== owner && !wsFrom && state.customers.find((x) => x.phone === from && x.removed);
    if (gone) {
      // the shop removed this customer: never silent, they get a short line and the owner is asked whether to reopen
      if (fromTo.length > 10) gone.waTo = fromTo;
      await act('customer', { custId: gone.id, text: text || (audio ? '[voice note]' : '[message]') });
      state = getState();
      save();
      return deliver(state, Math.min(start, state.messages.length));
    }

    let heard = null; // a voice note's transcript as heard, before cleaning (the AI reads it in its own script)
    if (audio) {
      try { heard = await transcribe(audio, audio.type); } catch (e) { stats.lastError = String(e.message || e).slice(0, 200); }
      // the agent reads a cleaned transcript: Devanagari in Latin letters, "paanch sau" as 500, no noise tags
      const clean = heard ? C.cleanTranscript(heard) : '';
      if (!clean) {
        const sorry = sttProvider ? '🎙️ Awaaz saaf samajh nahi aayi. Ek baar phir boliye, ya likh kar bhejiye 🙏' : '🎙️ Voice note abhi chalu nahi hai. Likh kar bhejiye 🙏';
        return queueSend(from === owner ? ownerTo : digits(params.From), sorry);
      }
      text = clean;
      if (from === owner) pre.push('🎙️ Suna: "' + heard + '"');
    }

    if (wsFrom) {
      if (fromTo.length > 10) wsFrom.waTo = fromTo;
      if (text) await act('wholesaler', { wsId: wsFrom.id, text });
      state = getState();
      save();
      return deliver(state, Math.min(start, state.messages.length));
    }

    if (from === owner) {
      const open = C.pendingClaims(state), yn = C.shortAnswer(text);
      const ask = open.find((k) => k.id === state.waAsked) || open[0];
      if (yn && ask && !state.pending && !(state.ownerAsks || []).length) await act('confirm', { claimId: ask.id, ok: yn === 'yes' });
      else if (text) await act('owner', { text, source: audio ? 'voice' : 'text', heard });
      state = getState();
      return deliver(state, Math.min(start, state.messages.length), pre);
    }

    const j = C.customerFromWhatsapp(state, from, params.ProfileName);
    const cust = j.cust;
    if (digits(params.From).length > 10) cust.waTo = digits(params.From);
    if (j.joined) {
      save();
      // "hi" / "join ..." only joins; a real message ("cash de diya") is also answered
      if (!text || /^(hi|hii+|hello|helo|hey|namaste|namaskar|join\b.*|start)\W*$/i.test(text)) return deliver(state, start);
    }
    const yn = C.shortAnswer(text), q = yn && openQuestion(state, cust, yn);
    if (q && q.kind === 'order') await act('orderAnswer', { custId: cust.id, orderId: q.orderId, udhaar: yn === 'yes' });
    else if (q && q.kind === 'consent') await act('consentAnswer', { custId: cust.id, yes: yn === 'yes' });
    else if (q) await act('customerCheck', { custId: cust.id, msgId: q.msgId, ok: yn === 'yes' });
    else if (text) await act('customer', { custId: cust.id, text, source: audio ? 'voice' : 'text', heard });
    state = getState();
    return deliver(state, Math.min(start, state.messages.length));
  }

  // ---------------------------------------------------------------- pages
  function page(title, body) {
    return '<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#1d1b16;margin:0;padding:24px 16px;display:flex;justify-content:center}main{max-width:420px;width:100%;text-align:center}' +
      'h1{font-size:22px;margin:0 0 6px}p{color:#5b564b;line-height:1.5}.amt{font-size:40px;font-weight:700;margin:12px 0}a.btn{display:block;background:#1f7a4d;color:#fff;text-decoration:none;padding:16px;border-radius:12px;font-size:18px;font-weight:600;margin:16px 0}' +
      '.qr svg{width:100%;max-width:300px;height:auto;background:#fff;padding:12px;border-radius:12px}.note{font-size:14px}</style></head><body><main>' + body + '</main></body></html>';
  }
  /** A customer's own pay page: today's baaki and a one-tap UPI button. No scanner, no typing the amount. */
  function payPage(state, ref) {
    const m = /^([A-Za-z0-9]{1,20})\.([0-9a-f]{16})$/.exec(ref || '');
    const c = m && state.customers.find((x) => x.id === m[1]);
    if (!c || !sameString(m[2], payToken(state, c.id))) return null;
    const bal = Math.max(0, Math.round(C.balance(state, c.id)));
    return page(state.shop.name, '<h1>' + esc(state.shop.name) + '</h1><p>' + esc(c.name) + ' ji, aapka baaki</p><div class="amt">' + esc(C.rupees(bal)) + '</div>' +
      (bal > 0 && state.shop.upiId ? '<a class="btn" href="' + esc(C.upiLink(state, c, bal)) + '">UPI app se dein</a>' : '') +
      '<p class="note">Cash dena ho toh dukaan par de dijiye aur WhatsApp par likhiye "cash de diya". Dono barabar hain.</p>');
  }
  /** Stage page: scan with any phone camera, WhatsApp opens with the join words typed in. */
  function joinPage(state) {
    const num = isMeta ? digits(env.META_WA_DISPLAY_NUMBER) : isWeb ? digits(env.WA_WEB_DISPLAY_NUMBER) || (web && web.status().linked && web.number && web.number()) || '' : digits(sender);
    if (!num) return null;
    const link = 'https://wa.me/' + num + '?text=' + encodeURIComponent(env.WA_JOIN_CODE || 'Namaste');
    const qr = require('../vendor/qrcode-generator.js')(0, 'M');
    qr.addData(link); qr.make();
    return page('Khate se judiye', '<h1>' + esc(state.shop.name) + '</h1><p>Phone ke camera se scan kijiye. WhatsApp khulega, bas Send dabaiye.</p><div class="qr">' + qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) + '</div>' +
      (env.WA_JOIN_CODE ? '<p class="note">Jud jaane ke baad ek "hi" bhejiye. Aap is dukaan ke grahak ban jayenge.</p>' : '') + '<p class="note">' + esc(link) + '</p>');
  }

  /**
   * Handle one inbound message and return the texts meant for its sender, for the TwiML reply. After `waitMs` the
   * webhook has to answer; anything for the sender after that goes out through the Messages API as usual.
   */
  function handleForReply(params, act, getState, save, waitMs) {
    const c = { to: digits(params.From), msgs: [], failed: [], skipped: [], open: true };
    capture = c;
    const done = handle(params, act, getState, save).then(() => outQueue);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(r, waitMs || 12000); });
    const replied = Promise.race([done, timeout]).then(() => {
      clearTimeout(timer); c.open = false; if (capture === c) capture = null;
      // the owner never believes a bill reached a customer when it was not sent or Twilio refused it
      const names = [...new Set(c.failed.map((to) => { const x = getState().customers.find((k) => k.waTo === to || '91' + k.phone === to); return x ? x.name : '+' + to; }).concat(c.skipped))];
      if (names.length && c.msgs.length && c.to === ownerTo) c.msgs.push('⚠️ WhatsApp nahi pahuncha: ' + names.join(', ') + '. Unhe is number par ek baar "hi" bhejne boliye. Yeh bill dobara apne aap nahi jayega.');
      return c.msgs.slice();
    });
    return { replied, done };
  }
  function twiml(msgs) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response>' + msgs.map((m) => '<Message>' + (m && m.media ? '<Media>' + esc(m.media) + '</Media>' : esc(m)) + '</Message>').join('') + '</Response>';
  }

  return {
    stats, provider, verify, handle, handleMeta, handleWeb, webReady: isWeb && stats.enabled, handleForReply, twiml, deliver, payPage, joinPage, getMedia, idle: () => outQueue,
    metaVerify, metaSignatureOk, metaPayload, inWindow, noteInbound,
    metaReady: isMeta && stats.enabled, twilioReady: !isMeta && !!(token && owner)
  };
}

module.exports = { createWhatsapp, twilioSignature, metaSignature, parseMetaWebhook, phone10 };
