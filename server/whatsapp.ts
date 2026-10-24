// Real WhatsApp for one shop, through a linked device on the shop's ordinary WhatsApp number (server/wa-web.ts).
//
// Inbound:  the linked session hands every message to handleWeb. The owner's number talks to the agent (text or voice
//           note); any other number is a customer. A new number becomes a customer under its WhatsApp name.
// Outbound: every message the agent writes to the owner or to a customer is sent on WhatsApp, whether it came from
//           a WhatsApp message, the web page, or the scheduler. Customers get messages only after they wrote first.
//           Sends are slow and capped against bans (wa-web.ts). Link the number first at /link?key=LINK_KEY.
//
// Environment:
//   OWNER_WHATSAPP                          the shop owner's own number, e.g. +919876543210
//   PUBLIC_URL                              this server's public https address (pay links)
//   WA_WEB_DISPLAY_NUMBER                   optional: the shop number (digits) for the /join QR
//   Voice notes are INPUT only by default: the owner or a customer speaks, the agent writes, the answer comes as text.
//   STT_URL, STT_KEY, STT_MODEL, STT_LANGUAGE   OpenAI-compatible speech-to-text for voice notes
//                                           (/audio/transcriptions; e.g. Whisper on a GPU).
//   ELEVENLABS_API_KEY                      without STT_URL, voice notes are transcribed by ElevenLabs Speech to Text
//   ELEVENLABS_STT_MODEL                    (default scribe_v1). Neither set = voice notes are refused politely.
//                                           STT_PROVIDER=off turns speech-to-text off.
//   WA_VOICE_REPLIES=1                      optional: customers ALSO get each bill and reminder as a Hindi voice note
//   ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL   (ElevenLabs text to speech, needs ELEVENLABS_API_KEY). Unset = text only.
import crypto = require('crypto');
import C = require('../core/agent-core');
import type { IncomingMessage } from 'http';
import type { State, Message, Customer } from '../core/types';
import type { WebTransport, WebMessage } from './wa-web';

type Env = Record<string, string | undefined>;
/** The parts of fetch this code uses; tests pass a fake. */
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string | undefined>; body?: string | FormData }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;
/** Runs one server action (owner, customer, confirm, ...) on the khata; see server.ts act(). */
export type Act = (kind: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
type InboundAudio = { web?: unknown; type?: string };
interface Inbound { from: string; name?: string; text?: string; audio: InboundAudio | null }
export interface WhatsappOpts { env: Env; fetch: FetchLike; now?: () => number; web?: WebTransport | null; getState?: () => State | null | undefined }
export type Whatsapp = ReturnType<typeof createWhatsapp>;

const MAX_AUDIO = 16 * 1024 * 1024;
const digits = (s: unknown) => String(s || '').replace(/\D/g, '');
const phone10 = (s: unknown) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null; };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

function sameString(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}


function createWhatsapp(o: WhatsappOpts) {
  const env = o.env, fetchImpl = o.fetch;
  const now = o.now || Date.now;
  const web = o.web || null; // the linked-device transport (wa-web.js)
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const owner = phone10(env.OWNER_WHATSAPP);
  const ownerTo = digits(env.OWNER_WHATSAPP);
  const sttUrl = (env.STT_URL || '').replace(/\/+$/, '');
  // Speech-to-text: an OpenAI-compatible STT_URL wins; otherwise ElevenLabs with the same key the shop already has.
  const sttProvider = env.STT_PROVIDER === 'off' ? null : sttUrl ? 'openai' : env.ELEVENLABS_API_KEY ? 'elevenlabs' : null;
  const elevenBase = (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  // the voice-note counters are added below only when they apply
  const stats: { provider: string; enabled: boolean; sending: boolean; stt: boolean; sttProvider: string | null; received: number; sent: number; failed: number; lastError: string | null | undefined;
    voiceNotes?: boolean; voiceSent?: number; voiceFailed?: number; ignored?: number } = {
    provider: 'web', enabled: !!(owner && web), sending: !!web,
    stt: !!sttProvider, sttProvider, received: 0, sent: 0, failed: 0, lastError: null
  };

  // ---------------------------------------------------------------- outbound
  let outQueue: Promise<unknown> = Promise.resolve();
  function sendNow(to: string, body: string): Promise<unknown> {
    if (!stats.sending || !to) return Promise.resolve();
    return web!.send(to, { text: String(body).slice(0, 4000) }).then((ok) => { if (ok) { stats.sent++; return true; } stats.failed++; stats.lastError = web!.status().lastError; return false; });
  }

  // In order, one after another, so a bill never arrives after its receipt.
  function queueSend(to: string, body: string) { outQueue = outQueue.then(() => sendNow(to, body)); return outQueue; }

  // ---------------------------------------------------------------- Hindi voice notes (ElevenLabs)
  // For customers who listen more than they read: the bill and the reminder also arrive as a short voice note in the
  // shop's name. The text always goes first; if the voice fails, the text alone is enough.
  const tts = { key: env.ELEVENLABS_API_KEY || '', voice: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM', model: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    api: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '') };
  // Replies are text only unless WA_VOICE_REPLIES=1: having an ElevenLabs key (used for speech-to-text) is not enough.
  stats.voiceNotes = !!(env.WA_VOICE_REPLIES === '1' && tts.key && web);
  const say = (n: number) => Math.round(n) + ' रुपये';
  const UNIT_WORD: Record<string, string> = { kg: 'kilo', g: 'gram', l: 'litre', ml: 'ml', pkt: 'packet', pc: '', pav: 'pav', dozen: 'dozen' };
  /** What the voice note says: short, in Hindi, in the shop's name. Null for messages that stay text only. */
  function voiceScript(state: State, m: Message): string | null {
    const c = state.customers.find((x) => x.id === m.to);
    if (!c) return null;
    const shop = state.shop.name, bal = Math.max(0, C.balance(state, c.id));
    if (m.kind === 'reminder' && m.amount! > 0)
      return 'नमस्ते ' + c.name + '। ' + shop + ' से बोल रहे हैं। आपके खाते में ' + say(m.amount!) + ' बाकी हैं। जब सुविधा हो, दुकान पर नकद या UPI से दे दीजिए। पैसे दे दिए हों तो "cash de diya" लिख दीजिए। धन्यवाद।';
    if (m.kind === 'statement') return 'नमस्ते ' + c.name + '। ' + shop + ' से। आपके खाते में ' + say(bal) + ' बाकी हैं। सही है तो "हाँ" लिखिए, गलत हो तो "गलत"।';
    if (m.kind === 'order-ask') {
      const o = (state.orders || []).find((x) => x.id === m.orderId);
      if (!o) return null;
      const items = o.lines.filter((l) => l.price != null).map((l) => l.name + (l.qty ? ' ' + l.qty + (l.unit ? ' ' + (UNIT_WORD[l.unit] || l.unit) : '') : '') + ', ' + say(l.price!)).join('; ');
      return 'नमस्ते ' + c.name + '। ' + shop + ' से। आपका ऑर्डर: ' + items + '। कुल ' + say(o.amount) + '। उधार में लिखना हो तो "हाँ" लिखिए, नकद देंगे तो "नहीं"।';
    }
    if (m.kind === 'entry-check') {
      const t = state.txns.find((x) => x.id === m.txnId);
      if (!t) return null;
      const items = (t.lines || []).filter((l) => l.price! > 0).map((l) => l.name + (l.qty ? ' ' + l.qty + (l.unit ? ' ' + (UNIT_WORD[l.unit] || l.unit) : '') : '') + ', ' + say(l.price!)).join('; ');
      return 'नमस्ते ' + c.name + '। ' + shop + ' से। आज आपके खाते में ' + say(t.amount) + (t.type === 'credit' ? ' उधार' : ' जमा') + ' लिखे गए' + (items ? ': ' + items : '') +
        '। कुल बाकी ' + say(bal) + '। सही है तो "हाँ" लिखिए, गलत हो तो "गलत"।';
    }
    return null;
  }
  // A linked-device voice note (ptt) has to be Ogg Opus to play as a voice note on phones.
  async function speak(text: string) {
    const r = await fetchImpl(tts.api + '/v1/text-to-speech/' + encodeURIComponent(tts.voice) + '?output_format=opus_48000_64', {
      method: 'POST', headers: { 'xi-api-key': tts.key, 'content-type': 'application/json', accept: 'audio/ogg' },
      body: JSON.stringify({ text, model_id: tts.model })
    });
    if (!r.ok) throw new Error('ElevenLabs HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  function queueVoice(to: string, script: string | null) {
    if (!stats.voiceNotes || !stats.sending || !script) return;
    outQueue = outQueue.then(async () => {
      try {
        const ok = await web!.send(to, { audio: await speak(script), mimetype: 'audio/ogg; codecs=opus' });
        if (ok) stats.voiceSent = (stats.voiceSent || 0) + 1; else stats.voiceFailed = (stats.voiceFailed || 0) + 1;
      }
      catch (e: any) { stats.voiceFailed = (stats.voiceFailed || 0) + 1; stats.lastError = String(e.message || e).slice(0, 200); }
    });
  }

  function payToken(state: State, custId: string) {
    if (!state.paySecret) state.paySecret = crypto.randomBytes(16).toString('hex');
    return crypto.createHmac('sha256', env.PAY_SECRET || state.paySecret).update(custId).digest('hex').slice(0, 16);
  }
  function payUrl(state: State, custId: string) { return publicUrl ? publicUrl + '/pay/' + custId + '.' + payToken(state, custId) : null; }

  /** The WhatsApp version of a message: the same words, plus how to answer. */
  function waText(state: State, m: Message) {
    let t = m.text;
    if ((m.kind === 'entry-check' && !m.list) || m.kind === 'statement') t += '\n\nJawab dijiye: *Haan* ya *Galat*'; // a list already ends with "haan / galat likhein"
    if (m.kind === 'consent-ask') t += '\n\nJawab dijiye: *Haan* ya *Nahi*';
    if (m.kind === 'reminder' && m.amount! > 0) { const u = payUrl(state, m.to); if (u) t += '\nUPI se dena ho toh: ' + u; }
    return t;
  }
  function recipient(state: State, to: string, kind?: string): string | null {
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
  function deliver(state: State, from: number, pre?: string[] | null, opts?: { skipOwner?: boolean }) {
    if (!stats.enabled) return;
    const skipOwner = !!(opts && opts.skipOwner); // the owner is looking at the web page already
    for (const t of pre || []) queueSend(ownerTo, t);
    const unsent: string[] = [];
    for (const m of state.messages.slice(from)) {
      if (m.from !== 'agent' || (skipOwner && m.to === 'owner')) continue;
      const to = recipient(state, m.to, m.kind);
      if (to && m.wsOrder) {
        // a stock order the owner approved: if WhatsApp refuses it (hourly cap, not linked), the owner hears so
        const name = ((state.wholesalers || []).find((x) => x.id === m.to) || {} as { name?: string }).name || 'Wholesaler';
        outQueue = outQueue.then(() => sendNow(to, waText(state, m))).then((ok) => {
          if (ok !== false) return;
          const o = (state.wsOrders || []).find((x) => x.id === m.wsOrder);
          if (o && o.status === 'sent') { o.status = 'unsent'; o.why = 'send-failed'; }
          return sendNow(ownerTo, '⚠️ ' + name + ' ko order WhatsApp par nahi gaya (WhatsApp ne abhi roka). Thodi der baad dobara boliye, ya phone par bata dijiye.');
        });
      } else if (to) { queueSend(to, waText(state, m)); if (m.to !== 'owner') queueVoice(to, voiceScript(state, m)); }
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
  /** audio: { web: the linked device's raw message, type }. */
  async function transcribe(audio: InboundAudio, type?: string): Promise<string | null> {
    if (!sttProvider) return null;
    const buf = Buffer.from(await web!.download(audio.web));
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
    const headers: Record<string, string> = env.STT_KEY ? { authorization: 'Bearer ' + env.STT_KEY } : {};
    const s = await fetchImpl(sttUrl + '/audio/transcriptions', { method: 'POST', headers, body: fd });
    if (!s.ok) throw new Error('STT HTTP ' + s.status);
    const j = await s.json();
    return String(j.text || '').trim().slice(0, 500);
  }

  // ---------------------------------------------------------------- inbound
  // The latest question this customer can answer with one word: an entry or monthly hisaab to check, or a lender's ask.
  function openQuestion(state: State, cust: Customer, answer: string): { kind: string; orderId?: string; msgId?: string } | null {
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

  /** One inbound linked-device message, as parseWebMessage gives it. Same handler again. */
  const seenWeb = new Set<string>();
  function handleWeb(m: WebMessage, act: Act, getState: () => State, save: () => void) {
    if (!web) return Promise.resolve();
    if (m.id) { if (seenWeb.has(m.id)) return Promise.resolve(); seenWeb.add(m.id); if (seenWeb.size > 1000) seenWeb.delete(seenWeb.values().next().value!); }
    return handleInbound({ from: m.from, name: m.name, text: m.text, audio: m.audio || null }, act, getState, save);
  }

  /**
   * One inbound WhatsApp message, whichever transport brought it: { from: digits with country code, name, text,
   * audio: null | { web, type } }. `act` is the server's action runner; the caller runs this one at a time.
   */
  async function handleInbound(msg: Inbound, act: Act, getState: () => State, save: () => void) {
    stats.received++;
    const from = phone10(msg.from), fromTo = digits(msg.from);
    if (!from || !stats.enabled) return;
    // "0000000000" and other non-mobile senders never get a khata or a guest entry (KAN-91)
    if (from !== owner && !/^[6-9]\d{9}$/.test(from)) { stats.ignored = (stats.ignored || 0) + 1; return; }
    const params = { From: fromTo, ProfileName: msg.name };
    let text = String(msg.text || '').trim().slice(0, 500);
    const audio = msg.audio || null;
    const pre: string[] = [];
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

    let heard: string | null = null; // a voice note's transcript as heard, before cleaning (the AI reads it in its own script)
    if (audio) {
      try { heard = await transcribe(audio, audio.type); } catch (e: any) { stats.lastError = String(e.message || e).slice(0, 200); }
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
  function page(title: string, body: string) {
    return '<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#1d1b16;margin:0;padding:24px 16px;display:flex;justify-content:center}main{max-width:420px;width:100%;text-align:center}' +
      'h1{font-size:22px;margin:0 0 6px}p{color:#5b564b;line-height:1.5}.amt{font-size:40px;font-weight:700;margin:12px 0}a.btn{display:block;background:#1f7a4d;color:#fff;text-decoration:none;padding:16px;border-radius:12px;font-size:18px;font-weight:600;margin:16px 0}' +
      '.qr svg{width:100%;max-width:300px;height:auto;background:#fff;padding:12px;border-radius:12px}.note{font-size:14px}</style></head><body><main>' + body + '</main></body></html>';
  }
  /** A customer's own pay page: today's baaki and a one-tap UPI button. No scanner, no typing the amount. */
  function payPage(state: State, ref: string) {
    const m = /^([A-Za-z0-9]{1,20})\.([0-9a-f]{16})$/.exec(ref || '');
    const c = m && state.customers.find((x) => x.id === m[1]);
    if (!c || !sameString(m![2], payToken(state, c.id))) return null;
    const bal = Math.max(0, Math.round(C.balance(state, c.id)));
    return page(state.shop.name, '<h1>' + esc(state.shop.name) + '</h1><p>' + esc(/\b(ji|bhai|bhau|didi|aunty|uncle|sahab|saheb|madam|mausi|chacha|tai|sir|kaka|kaku|mama|seth)$/i.test(c.name.trim()) ? c.name.trim() : c.name.trim() + ' ji') + ', aapka baaki</p><div class="amt">' + esc(C.rupees(bal)) + '</div>' +
      (bal > 0 && state.shop.upiId ? '<a class="btn" href="' + esc(C.upiLink(state, c, bal)) + '">UPI app se dein</a>' : '') +
      '<p class="note">Cash dena ho toh dukaan par de dijiye aur WhatsApp par likhiye "cash de diya". Dono barabar hain.</p>');
  }
  /** Stage page: scan with any phone camera, WhatsApp opens with a greeting typed in. */
  function joinPage(state: State) {
    const num = digits(env.WA_WEB_DISPLAY_NUMBER) || (web && web.status().linked && web.number && web.number()) || '';
    if (!num) return null;
    const link = 'https://wa.me/' + num + '?text=' + encodeURIComponent('Namaste');
    // vendored untyped UMD script; compiled to dist-server/server/, two levels below the repo root
    const qr = (require('../../vendor/qrcode-generator.js') as any)(0, 'M');
    qr.addData(link); qr.make();
    return page('Khate se judiye', '<h1>' + esc(state.shop.name) + '</h1><p>Phone ke camera se scan kijiye. WhatsApp khulega, bas Send dabaiye.</p><div class="qr">' + qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) + '</div>' +
      '<p class="note">' + esc(link) + '</p>');
  }

  return {
    stats, provider: 'web', handleWeb, webReady: !!web && stats.enabled, deliver, payPage, joinPage, idle: () => outQueue
  };
}

export { createWhatsapp, phone10 };
