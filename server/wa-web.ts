// The WhatsApp transport: a linked device on an ordinary WhatsApp number (like WhatsApp Web), through the
// Baileys multi-device library (no browser). Linked by QR at GET /link.
//
// This is not an official API. WhatsApp's terms do not allow it and the number can be banned, so the sends here are
// kept slow and human-like: one at a time, 2-4 s apart with a typing indicator, at most WA_WEB_MAX_PER_HOUR
// (default 30) business-initiated messages per hour, and only to people the existing rules allow (khata customers
// who wrote first, and the owner). Nothing is ever broadcast.
//
// Environment:
//   WA_WEB_AUTH_DIR        where the link (session keys) is kept; default /home/node/data/wa-web-auth
//   WA_WEB_MAX_PER_HOUR    business-initiated sends per hour (default 30); replies to someone who wrote in the
//                          last 30 minutes are not counted
//   LINK_KEY               the secret in /link?key=..., the page that shows the QR to scan.
//   WA_WEB_DISPLAY_NUMBER  optional: the linked number (digits) for the /join QR; default the linked number itself
import fs = require('fs');

// Baileys is loaded at run time (o.loadLib) and is not a typed dependency here, so its module, socket, events and raw
// messages are `any`; parseWebMessage checks every field it reads.
type Baileys = any;
type RawMessage = any;
export interface WebMessage { id: string; from: string; name: string; text: string; audio: { web: RawMessage; type: string } | null }
export interface SendContent { text?: string; audio?: Buffer; mimetype?: string; image?: Buffer; caption?: string }
export interface WebTransportOpts {
  authDir: string;
  loadLib: () => Promise<Baileys>;
  onMessage?: (msg: WebMessage) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  maxPerHour?: number;
  keepAlive?: boolean;
}
export type WebTransport = ReturnType<typeof createWebTransport>;

const REPLY_WINDOW = 30 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const digits = (s: unknown) => String(s || '').replace(/\D/g, '');

/** The phone-number JID among a message key's addresses (newer WhatsApp sends a hidden "@lid" id plus the number). */
function pnJid(key: RawMessage): string | null {
  for (const j of [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participantAlt]) if (j && /@s\.whatsapp\.net$/.test(j)) return j;
  return null;
}

/** Unwraps disappearing / view-once / edited wrappers to the real message content. */
function unwrap(c: RawMessage): RawMessage {
  for (let i = 0; i < 5 && c; i++) {
    const inner = (c.ephemeralMessage || c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension || c.documentWithCaptionMessage || {}).message;
    if (!inner) break;
    c = inner;
  }
  return c;
}

/**
 * One Baileys message in the transport-neutral shape, or null when it must be ignored (our own messages, groups,
 * status updates, broadcasts, channels, protocol messages, numbers we cannot see).
 * { id, from: '919812345678', name, text, audio: { web: rawMessage, type } | null }
 */
function parseWebMessage(m: RawMessage): WebMessage | null {
  if (!m || !m.key || !m.message) return null;
  const k = m.key;
  const jid = String(k.remoteJid || '');
  if (k.fromMe) return null;
  if (/@g\.us$|@broadcast$|@newsletter$|^status@/.test(jid) || k.participant) return null;
  const pn = pnJid(k);
  if (!pn) return null;
  const c = unwrap(m.message);
  if (!c) return null;
  let text = '', audio: WebMessage['audio'] = null;
  if (typeof c.conversation === 'string') text = c.conversation;
  else if (c.extendedTextMessage) text = c.extendedTextMessage.text || '';
  else if (c.audioMessage) audio = { web: m, type: String(c.audioMessage.mimetype || 'audio/ogg').split(';')[0] };
  else if (c.buttonsResponseMessage) text = c.buttonsResponseMessage.selectedDisplayText || c.buttonsResponseMessage.selectedButtonId || '';
  else if (c.templateButtonReplyMessage) text = c.templateButtonReplyMessage.selectedDisplayText || c.templateButtonReplyMessage.selectedId || '';
  else if (c.listResponseMessage) text = c.listResponseMessage.title || (c.listResponseMessage.singleSelectReply || {}).selectedRowId || '';
  else if (c.imageMessage || c.videoMessage || c.documentMessage) text = (c.imageMessage || c.videoMessage || c.documentMessage).caption || '';
  else return null; // reactions, protocol messages, stickers, calls ...
  if (!text && !audio) return null;
  return { id: String(k.id || ''), from: digits(pn.split('@')[0].split(':')[0]), name: String(m.pushName || ''), text: String(text), audio };
}

/** A logger Baileys accepts (pino-like); only errors are printed, briefly. */
function quietLogger() {
  const l = { level: 'error', trace() {}, debug() {}, info() {}, warn() {},
    error(o: any, msg?: string) { console.log('wa-web: ' + String(msg || (o && o.err && o.err.message) || (o && o.msg) || '').slice(0, 160)); },
    fatal(o: any, msg?: string) { l.error(o, msg); }, child() { return l; } };
  return l;
}

/**
 * o: { authDir, loadLib: () => Promise<baileys module>, onMessage(msg), now, sleep(ms), random(), maxPerHour,
 *      keepAlive (true: stay connected and reconnect always) }
 */
function createWebTransport(o: WebTransportOpts) {
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = o.random || Math.random;
  const maxPerHour = o.maxPerHour || 30;
  const authDir = o.authDir;
  const st: { state: string; qr: string | null; me: string | null; lastError: string | null; reconnects: number; sent: number; failed: number; capped: number; received: number; ignored: number } = { state: 'off', qr: null, me: null, lastError: null, reconnects: 0, sent: 0, failed: 0, capped: 0, received: 0, ignored: 0 };
  let lib: Baileys = null, sock: any = null, starting: Promise<void> | null = null, retry = 0, retryTimer: ReturnType<typeof setTimeout> | null = null, wantedAt = 0, gen = 0;
  const lastInbound = new Map<string, number>();
  const business: number[] = []; // times of business-initiated sends in the last hour

  function canReconnect(registered: boolean) { return o.keepAlive || registered || now() - wantedAt < 3 * 60 * 1000; }
  function schedule(ms: number) {
    clearTimeout(retryTimer!);
    retryTimer = setTimeout(() => { retryTimer = null; open().catch((e) => { st.lastError = String(e.message || e).slice(0, 200); }); }, ms);
    if (retryTimer.unref) retryTimer.unref();
  }

  async function open(): Promise<void> {
    if (starting) return starting;
    starting = (async () => {
      lib = lib || await o.loadLib();
      fs.mkdirSync(authDir, { recursive: true });
      const { state, saveCreds } = await lib.useMultiFileAuthState(authDir);
      let version;
      try { version = (await lib.fetchLatestBaileysVersion()).version; } catch (e) { version = undefined; }
      const my = ++gen;
      st.state = 'connecting';
      const make = lib.makeWASocket || lib.default;
      const s = make({ auth: state, version, logger: quietLogger(), browser: lib.Browsers ? lib.Browsers.ubuntu('Udhaar') : undefined,
        printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false });
      sock = s;
      s.ev.on('creds.update', saveCreds);
      s.ev.on('connection.update', (u: any) => {
        if (my !== gen) return;
        if (u.qr) { st.qr = u.qr; st.state = 'qr'; }
        if (u.connection === 'open') {
          st.state = 'connected'; st.qr = null; st.lastError = null; retry = 0;
          st.me = s.user && s.user.id ? digits(String(s.user.id).split('@')[0].split(':')[0]) : null;
          console.log('wa-web: linked and connected');
        }
        if (u.connection === 'close') {
          sock = null;
          const err = u.lastDisconnect && u.lastDisconnect.error;
          const code = err && err.output && err.output.statusCode;
          const R = lib.DisconnectReason || {};
          st.lastError = 'closed ' + (code || '') + ' ' + String((err && err.message) || '').slice(0, 120);
          const registered = !!(state.creds && state.creds.registered);
          if (code === (R.loggedOut || 401)) {
            // unlinked from the phone: forget the keys and show a fresh QR
            console.log('wa-web: logged out, clearing the link');
            try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
            st.state = 'logged_out'; st.me = null; st.qr = null; retry = 0;
            if (canReconnect(false)) schedule(2000);
            return;
          }
          if (!canReconnect(registered)) { st.state = registered ? 'disconnected' : 'off'; st.qr = null; return; }
          st.state = 'reconnecting'; st.reconnects++;
          const wait = code === (R.restartRequired || 515) ? 500 : Math.min(60000, 2000 * Math.pow(2, retry++));
          schedule(wait);
        }
      });
      s.ev.on('messages.upsert', (up: any) => {
        if (my !== gen || !up || up.type !== 'notify') return;
        for (const m of up.messages || []) {
          const msg = parseWebMessage(m);
          if (!msg) { st.ignored++; continue; }
          st.received++;
          lastInbound.set(msg.from, now());
          try { o.onMessage && o.onMessage(msg); } catch (e: any) { st.lastError = String(e.message || e).slice(0, 200); }
        }
      });
    })();
    try { await starting; } finally { starting = null; }
  }

  /** Starts the link if it is not running (the /link page calls this; the server calls it at boot). */
  function start() {
    wantedAt = now();
    if (starting) return starting.catch(() => {});
    if (sock || retryTimer) return Promise.resolve();
    return open().catch((e) => { st.state = 'error'; st.lastError = String(e.message || e).slice(0, 200); });
  }

  // ------------------------------------------------------------------ sending: one at a time, slow, capped
  let chain: Promise<unknown> = Promise.resolve();
  let lastSendAt = 0;
  const pending = { n: 0 };
  function isReply(to: string) { const t = lastInbound.get(to); return !!t && now() - t < REPLY_WINDOW; }
  function overCap() {
    while (business.length && now() - business[0] >= HOUR) business.shift();
    return business.length >= maxPerHour;
  }
  async function sendOne(to: string, content: SendContent): Promise<boolean> {
    if (!sock || st.state !== 'connected') { st.failed++; st.lastError = 'not connected, message to +' + to + ' dropped'; return false; }
    const reply = isReply(to);
    if (!reply && overCap()) { st.capped++; console.log('wa-web: hourly cap of ' + maxPerHour + ' reached, message to +' + to + ' dropped'); return false; }
    const jid = to + '@s.whatsapp.net';
    const gap = 2000 + Math.floor(random() * 2000);
    const wait = lastSendAt ? Math.max(0, lastSendAt + gap - now()) : 0;
    if (wait) await sleep(wait);
    try {
      const s = sock;
      if (!s) throw new Error('not connected');
      await s.sendPresenceUpdate(content.audio ? 'recording' : 'composing', jid).catch(() => {});
      await sleep(content.audio ? 1500 : Math.min(2500, 600 + String(content.text || '').length * 15));
      await s.sendPresenceUpdate('paused', jid).catch(() => {});
      if (content.audio) await s.sendMessage(jid, { audio: content.audio, mimetype: content.mimetype || 'audio/ogg; codecs=opus', ptt: true });
      else if (content.image) await s.sendMessage(jid, { image: content.image, mimetype: content.mimetype || 'image/png', caption: content.caption || '' });
      else await s.sendMessage(jid, { text: String(content.text) });
      st.sent++;
      if (!reply) business.push(now());
      return true;
    } catch (e: any) {
      st.failed++; st.lastError = String(e.message || e).slice(0, 200);
      return false;
    } finally { lastSendAt = now(); }
  }
  /** Queues one message; resolves true when WhatsApp took it. content: { text }, { audio: Buffer, mimetype } or { image: Buffer, caption }. */
  function send(to: string, content: SendContent): Promise<boolean> {
    to = digits(to);
    if (!to) return Promise.resolve(false);
    pending.n++;
    const p = chain.then(() => sendOne(to, content)).finally(() => { pending.n--; });
    chain = p.catch(() => false);
    return p;
  }

  /** The voice note's bytes (for speech-to-text). */
  async function download(raw: RawMessage): Promise<Buffer> {
    if (!lib) throw new Error('not started');
    const s = sock;
    return lib.downloadMediaMessage(raw, 'buffer', {}, s ? { logger: quietLogger(), reuploadRequest: s.updateMediaMessage } : { logger: quietLogger() });
  }

  function status() {
    while (business.length && now() - business[0] >= HOUR) business.shift();
    return { state: st.state, linked: st.state === 'connected', number: st.me ? '+' + st.me.slice(0, -4).replace(/\d/g, 'x') + st.me.slice(-4) : null,
      received: st.received, ignored: st.ignored, sent: st.sent, failed: st.failed, capped: st.capped, queued: pending.n,
      businessLastHour: business.length, maxPerHour, reconnects: st.reconnects, lastError: st.lastError };
  }

  function stop() { gen++; clearTimeout(retryTimer!); retryTimer = null; const s = sock; sock = null; if (s && s.end) try { s.end(undefined); } catch (e) { /* closed */ } }

  /** Unlinks the number (WhatsApp logout when connected) and forgets its keys; start() afterwards shows a new QR. */
  async function logout() {
    gen++; clearTimeout(retryTimer!); retryTimer = null;
    const s = sock; sock = null;
    if (s) { try { if (s.logout) await s.logout(); else if (s.end) s.end(undefined); } catch (e) { /* already closed */ } }
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
    st.state = 'off'; st.me = null; st.qr = null; retry = 0;
  }

  return { start, stop, logout, send, download, status, qr: () => st.qr, state: () => st.state, number: () => st.me, idle: () => chain };
}

export { createWebTransport, parseWebMessage };
