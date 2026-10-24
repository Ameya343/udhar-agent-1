// A stand-in for the linked-device transport (server/wa-web.js) for server tests: no Baileys, no network.
// Sends are handed to push(to, content); inbound(server, fields) delivers one message as the linked session would.
'use strict';

function fakeWeb(push) {
  const w = { cfg: null, downloads: 0, fail: false };
  w.factory = (cfg) => {
    w.cfg = cfg;
    return {
      start: async () => {}, stop() {}, idle: () => Promise.resolve(), qr: () => null, number: () => '919800000009',
      status: () => ({ state: 'connected', linked: true, number: '919800000009', lastError: w.fail ? 'send refused' : null }),
      download: async () => { w.downloads++; return Buffer.from('OggS fake voice'); },
      send: async (to, content) => { if (w.fail) return false; push(to, content); return true; }
    };
  };
  // fields: { From: '+91...' or 'whatsapp:+91...', ProfileName, Body, NumMedia, MediaContentType0 }
  w.inbound = async (server, f) => {
    const audio = +f.NumMedia > 0 && /^audio\//.test(f.MediaContentType0 || '') ? { web: { fake: true }, type: f.MediaContentType0 } : null;
    w.cfg.onMessage({ id: f.MessageSid || 'W' + Math.random().toString(16).slice(2), from: String(f.From).replace(/\D/g, ''), name: f.ProfileName || '', text: f.Body || '', audio });
    await server.idle();
    return { status: 200 };
  };
  return w;
}

module.exports = { fakeWeb };
