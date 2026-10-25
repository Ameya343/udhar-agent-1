// One entry page for every owner: register a brand-new (empty) shop or log in to your own; each owner account belongs
// to exactly one shop, every API is scoped to the session's shop, the instance's own shop (gupta) is untouched, and
// each registered shop can link its own WhatsApp number (one linked-device session per shop, mocked here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const { fakeWeb } = require('./fake-wa.js');

const TODAY = '2026-10-25';
const GUPTA_N = require('../dist-server/core/agent-core.js').freshShop('gupta', TODAY).customers.length;
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-multi-'));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)));
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

// a fake linked-device transport per auth dir (one per shop), recording every send by the socket that sent it
function fakeSockets() {
  const socks = new Map();
  const factory = (cfg) => {
    const s = { cfg, sent: [], state: 'off', loggedOut: false, started: 0 };
    s.t = {
      start: async () => { s.started++; s.state = 'connected'; }, stop() { s.state = 'off'; }, logout: async () => { s.loggedOut = true; s.state = 'off'; },
      idle: () => Promise.resolve(), qr: () => null, number: () => '919000000001', download: async () => Buffer.from(''),
      status: () => ({ state: s.state, linked: s.state === 'connected', number: '+91xxxxxx0001', lastError: null }),
      send: async (to, content) => { s.sent.push([to, content.text]); return true; }
    };
    socks.set(cfg.authDir, s);
    return s.t;
  };
  return { socks, factory };
}

async function boot(t, envExtra, o) {
  const dir = (o && o.dir) || tmpDir();
  const env = Object.assign({ SHOP: 'gupta', DATA_DIR: dir, ADMIN_KEY: 'admin-secret' }, envExtra || {});
  const srv = createServer(Object.assign({ env, today: () => TODAY }, o && o.server));
  const base = await listen(srv);
  let n = 1;
  const call = (method, p, body, cookie, ip) => fetch(base + p, { method, headers: Object.assign({ 'x-forwarded-for': ip || '10.1.0.' + (n++ % 250 + 1), 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: body ? JSON.stringify(body) : undefined });
  t.after(() => new Promise((r) => srv.close(r)));
  return { srv, base, dir, call };
}
const SHOP_A = { shopName: 'Tiwari General Store', ownerName: 'Harshit Tiwari', phone: '9811111111', password: 'tiwari-pass' };
const SHOP_B = { shopName: 'Sharma Provision', ownerName: 'Anil Sharma', phone: '9822222222', password: 'sharma-pass' };

test('register: a brand-new empty shop, the owner is logged straight into it, never Gupta Kirana', async (t) => {
  const s = await boot(t);
  const r = await s.call('POST', '/api/auth/register', SHOP_A);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.match(j.shopId, /^s[0-9a-f]{10}$/);
  const c = cookieOf(r);
  assert.ok(c.startsWith('udhaar_owner=' + j.shopId + '.'));
  const st = await (await s.call('GET', '/api/state', null, c)).json();
  assert.strictEqual(st.shopId, j.shopId);
  assert.strictEqual(st.state.shop.name, 'Tiwari General Store');
  assert.strictEqual(st.state.customers.length, 0, 'no demo customers');
  assert.strictEqual((st.state.wholesalers || []).length, 0, 'no demo wholesalers');
  assert.strictEqual(st.state.txns.length, 0);
  assert.ok(!JSON.stringify(st).includes('Gupta'), 'nothing of Gupta Kirana');
  assert.strictEqual(st.whatsapp.connected, false);
  assert.match(st.whatsapp.note, /WhatsApp not connected yet/);
  const au = await (await s.call('GET', '/api/auth/status', null, c)).json();
  assert.strictEqual(au.owner, true); assert.strictEqual(au.shopId, j.shopId); assert.strictEqual(au.name, 'Harshit Tiwari');
  // the instance's own shop is untouched
  assert.strictEqual(s.srv.getState().shop.name, 'Gupta Kirana Store');
  assert.strictEqual(s.srv.getState().customers.length, GUPTA_N);
});

test('login opens only the owner\'s own shop; Gupta\'s owner still logs into Gupta', async (t) => {
  const s = await boot(t, { REAL_CLOCK: '1' });
  const gs = await s.call('POST', '/api/auth/setup', { adminKey: 'admin-secret', phone: '9876543210', password: 'gupta-pass', shopName: 'Gupta Kirana Store', ownerName: 'Rakesh Gupta', address: 'Nagpur', gstRegistered: false, pan: 'ABCDE1234F' });
  assert.strictEqual(gs.status, 200);
  await s.call('POST', '/api/auth/register', SHOP_A);
  const la = await s.call('POST', '/api/auth/login', { phone: SHOP_A.phone, password: SHOP_A.password });
  assert.strictEqual(la.status, 200);
  const a = await (await s.call('GET', '/api/state', null, cookieOf(la))).json();
  assert.strictEqual(a.state.shop.name, 'Tiwari General Store'); assert.strictEqual(a.state.customers.length, 0); assert.strictEqual(a.locked, false);
  const lg = await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'gupta-pass' });
  assert.strictEqual(lg.status, 200);
  const g = await (await s.call('GET', '/api/state', null, cookieOf(lg))).json();
  assert.strictEqual(g.shopId, 'gupta'); assert.strictEqual(g.state.customers.length, GUPTA_N);
  // wrong password for a registered shop's owner: refused, then the lockout still applies
  for (let i = 0; i < 4; i++) assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: SHOP_A.phone, password: 'nope-nope' })).status, 401);
  assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: SHOP_A.phone, password: 'nope-nope' })).status, 429);
  assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: SHOP_A.phone, password: SHOP_A.password })).status, 429, 'locked even with the right password');
  // a visitor with no login sees no khata at all on a live server
  const pub = await (await s.call('GET', '/api/state')).json();
  assert.strictEqual(pub.locked, true); assert.strictEqual(pub.state.customers.length, 0);
});

test('isolation: owner B can neither read nor change shop A (or Gupta), whatever cookie they forge', async (t) => {
  const s = await boot(t, { REAL_CLOCK: '1' });
  const ra = await s.call('POST', '/api/auth/register', SHOP_A), ca = cookieOf(ra), idA = (await ra.json()).shopId;
  const rb = await s.call('POST', '/api/auth/register', SHOP_B), cb = cookieOf(rb), idB = (await rb.json()).shopId;
  assert.notStrictEqual(idA, idB);
  const w = await s.call('POST', '/api/act', { action: 'owner', args: { text: 'Ramesh ke 500 baaki hain' } }, ca);
  assert.strictEqual(w.status, 200);
  const A1 = await (await s.call('GET', '/api/state', null, ca)).json();
  assert.ok(A1.state.customers.length >= 1 || A1.state.messages.length > 1, 'shop A changed');
  const aBefore = JSON.stringify((await s.srv.shop(idA)).state);
  // B's own view
  const B = await (await s.call('GET', '/api/state', null, cb)).json();
  assert.strictEqual(B.shopId, idB); assert.strictEqual(B.state.customers.length, 0);
  assert.ok(!JSON.stringify(B).includes('Ramesh') && !JSON.stringify(B).includes('Tiwari'));
  // B acts: only B changes
  await s.call('POST', '/api/act', { action: 'owner', args: { text: 'Suresh ke 300 baaki hain' } }, cb);
  assert.strictEqual(JSON.stringify((await s.srv.shop(idA)).state), aBefore, 'A untouched by B');
  // forged: A's shop id in front of B's token -> no session anywhere
  const tokB = cb.split('=')[1].split('.')[1];
  for (const forged of ['udhaar_owner=' + idA + '.' + tokB, 'udhaar_owner=gupta.' + tokB, 'udhaar_owner=' + tokB]) {
    const st = await (await s.call('GET', '/api/state', null, forged)).json();
    assert.strictEqual(st.locked, true, forged); assert.strictEqual(st.state.customers.length, 0);
    assert.strictEqual((await s.call('POST', '/api/act', { action: 'owner', args: { text: 'Mohan ke 900 baaki hain' } }, forged)).status, 403);
    assert.strictEqual((await s.call('GET', '/api/profile', null, forged)).status, 403);
  }
  assert.strictEqual(JSON.stringify((await s.srv.shop(idA)).state), aBefore);
  // B's profile save and password change touch B only
  const pf = await s.call('POST', '/api/profile', { shopName: 'Sharma Provision 2', ownerName: 'Anil Sharma', address: 'Pune', gstRegistered: false, pan: 'ABCDE1234F' }, cb);
  assert.strictEqual(pf.status, 200);
  assert.strictEqual((await s.srv.shop(idA)).state.shop.name, 'Tiwari General Store');
  assert.strictEqual(s.srv.getState().shop.name, 'Gupta Kirana Store');
  assert.strictEqual((await s.call('POST', '/api/auth/password', { current: SHOP_A.password, password: 'hijack-123' }, cb)).status, 401, 'B cannot use A\'s password');
  // logging out of B does not log A out
  await s.call('POST', '/api/auth/logout', {}, cb);
  assert.strictEqual((await (await s.call('GET', '/api/state', null, cb)).json()).locked, true);
  assert.strictEqual((await (await s.call('GET', '/api/state', null, ca)).json()).shopId, idA);
});

test('register: validation, one shop per phone (also Gupta\'s owner), and the rate limit', async (t) => {
  const s = await boot(t);
  assert.strictEqual((await s.call('POST', '/api/auth/setup', { adminKey: 'admin-secret', phone: '9876543210', password: 'gupta-pass', shopName: 'G', ownerName: 'R', address: 'N', gstRegistered: false, pan: 'ABCDE1234F' })).status, 200);
  const bad = [[{ shopName: '' }, /Shop name/], [{ ownerName: '' }, /Owner name/], [{ phone: '123' }, /10-digit/], [{ password: '111111' }, /less obvious/], [{ password: 'abc' }, /at least 6/],
    [{ gstin: '27AAPFU0939F1ZW' }, /check character/], [{ pan: 'ABC' }, /PAN/]];
  for (const [patch, re] of bad) {
    const r = await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_A, patch));
    assert.strictEqual(r.status, 400, JSON.stringify(patch)); assert.match((await r.json()).error, re);
  }
  assert.strictEqual(s.srv.registry.list().length, 0, 'nothing created for a bad form');
  const ok = await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_A, { gstin: '27AAPFU0939F1ZV' }));
  assert.strictEqual(ok.status, 200);
  const prof = await (await s.call('GET', '/api/profile', null, cookieOf(ok))).json();
  assert.strictEqual(prof.profile.taxKind, 'GSTIN'); assert.strictEqual(prof.profile.taxIdMasked, 'XXXXXXXXXXXF1ZV');
  assert.strictEqual((await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_B, { phone: SHOP_A.phone }))).status, 409);
  assert.strictEqual((await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_B, { phone: '9876543210' }))).status, 409, 'Gupta\'s owner number');
  // the rate limit: REGISTER_LIMIT_PER_HOUR (default 5) per visitor address
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_B, { phone: '97000000' + (10 + i) }), null, '10.9.9.9')).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
});

test('a registered shop survives a restart; Gupta\'s khata file is never touched', async (t) => {
  const dir = tmpDir();
  const s1 = await boot(t, {}, { dir });
  const guptaFile = path.join(dir, 'gupta.json');
  await s1.srv.idle();
  const before = fs.readFileSync(guptaFile, 'utf8');
  const r = await s1.call('POST', '/api/auth/register', SHOP_A), id = (await r.json()).shopId;
  await s1.call('POST', '/api/act', { action: 'owner', args: { text: 'Ramesh ke 500 baaki hain' } }, cookieOf(r));
  await s1.srv.idle();
  assert.strictEqual(fs.readFileSync(guptaFile, 'utf8'), before, 'gupta.json unchanged');
  assert.ok(fs.existsSync(path.join(dir, id + '.json')) && fs.existsSync(path.join(dir, id + '.auth.json')));
  const saved = fs.readFileSync(path.join(dir, id + '.json'), 'utf8');
  await new Promise((res) => s1.srv.close(res));
  const s2 = await boot(t, {}, { dir });
  const lg = await s2.call('POST', '/api/auth/login', { phone: SHOP_A.phone, password: SHOP_A.password });
  assert.strictEqual(lg.status, 200);
  const st = await (await s2.call('GET', '/api/state', null, cookieOf(lg))).json();
  assert.strictEqual(JSON.stringify(st.state.customers), JSON.stringify(JSON.parse(saved).customers));
  assert.strictEqual(s2.srv.getState().customers.length, GUPTA_N);
});

test('WhatsApp per shop: own socket, messages route only to that shop, no cross-shop sends, cap, disconnect, reconnect on restart', async (t) => {
  const dir = tmpDir();
  const home = fakeWeb(() => {}), homeSent = [];
  const H = fakeWeb((to, c) => homeSent.push([to, c.text]));
  void home;
  const F = fakeSockets();
  // the instance's own WhatsApp (gupta) runs on H with its usual auth dir; registered shops get their own sockets from F
  const factory = (cfg) => (cfg.authDir === path.join(dir, 'wa-web-auth') ? H.factory(cfg) : F.factory(cfg));
  const env = { OWNER_WHATSAPP: '919511681331', LINK_KEY: 'lk', WA_MAX_SHOPS: '2' };
  const s = await boot(t, env, { dir, server: { webTransport: factory } });
  assert.strictEqual(H.cfg.authDir, path.join(dir, 'wa-web-auth'), 'Gupta keeps its existing session dir: no re-scan');
  const ra = await s.call('POST', '/api/auth/register', SHOP_A), ca = cookieOf(ra), idA = (await ra.json()).shopId;
  const rb = await s.call('POST', '/api/auth/register', SHOP_B), cb = cookieOf(rb), idB = (await rb.json()).shopId;
  const rc = await s.call('POST', '/api/auth/register', Object.assign({}, SHOP_B, { phone: '9833333333' })), cc = cookieOf(rc);
  assert.strictEqual(F.socks.size, 0, 'no session until the owner connects');
  const conA = await s.call('POST', '/api/wa/connect', {}, ca);
  assert.strictEqual(conA.status, 200); assert.strictEqual((await conA.json()).connected, true);
  assert.strictEqual((await s.call('POST', '/api/wa/connect', {}, cb)).status, 200);
  const capped = await s.call('POST', '/api/wa/connect', {}, cc);
  assert.strictEqual(capped.status, 409); assert.match((await capped.json()).error, /WA_MAX_SHOPS/);
  const sa = F.socks.get(path.join(dir, 'wa-web-auth-shops', idA)), sb = F.socks.get(path.join(dir, 'wa-web-auth-shops', idB));
  assert.ok(sa && sb && sa !== sb);
  // A's owner writes to A's number: only A's khata changes, replies go out on A's socket to A's owner only
  const aMsgs = (await s.srv.shop(idA)).state.messages.length, bState = JSON.stringify((await s.srv.shop(idB)).state), gState = JSON.stringify(s.srv.getState());
  sa.cfg.onMessage({ id: 'm1', from: '91' + SHOP_A.phone, name: 'Harshit', text: 'Ramesh ke 500 baaki hain', audio: null });
  await s.srv.idle();
  assert.ok((await s.srv.shop(idA)).state.messages.length > aMsgs, 'A handled it');
  assert.strictEqual(JSON.stringify((await s.srv.shop(idB)).state), bState, 'B untouched');
  assert.strictEqual(JSON.stringify(s.srv.getState()), gState, 'Gupta untouched');
  assert.ok(sa.sent.length > 0 && sa.sent.every(([to]) => to === '91' + SHOP_A.phone), 'A replies to its own owner on its own socket');
  assert.strictEqual(sb.sent.length, 0); assert.strictEqual(homeSent.length, 0, 'nothing on Gupta\'s number');
  // B's owner number written to A's socket is just a stranger to shop A, never B's owner
  sa.cfg.onMessage({ id: 'm2', from: '91' + SHOP_B.phone, name: 'Anil', text: 'Suresh ke 300 baaki hain', audio: null });
  await s.srv.idle();
  assert.strictEqual(JSON.stringify((await s.srv.shop(idB)).state), bState);
  assert.ok(!(await s.srv.shop(idA)).state.txns.some((x) => x.amount === 300), 'a stranger cannot write udhaar in A');
  assert.strictEqual(sb.sent.length, 0); assert.strictEqual(homeSent.length, 0);
  const aSent = sa.sent.length;
  // Gupta's own number still routes to Gupta only
  await H.inbound(s.srv, { From: '+919511681331', Body: 'Sharma ji ne 340 ka saaman liya' });
  assert.ok(homeSent.length > 0); assert.strictEqual(sa.sent.length, aSent); assert.strictEqual(sb.sent.length, 0);
  // a web entry by B's owner reaches only B's socket (customers who never wrote get nothing)
  await s.call('POST', '/api/act', { action: 'owner', args: { text: 'Suresh ke 300 baaki hain' } }, cb);
  await s.srv.idle();
  assert.strictEqual(sa.sent.length, aSent, 'B\'s entry sends nothing on A\'s socket');
  // status and disconnect
  const stB = await (await s.call('GET', '/api/wa/status', null, cb)).json();
  assert.strictEqual(stB.connected, true);
  fs.mkdirSync(sa.cfg.authDir, { recursive: true }); fs.writeFileSync(path.join(sa.cfg.authDir, 'creds.json'), '{}');
  fs.mkdirSync(sb.cfg.authDir, { recursive: true }); fs.writeFileSync(path.join(sb.cfg.authDir, 'creds.json'), '{}');
  const dis = await (await s.call('POST', '/api/wa/disconnect', {}, cb)).json();
  assert.strictEqual(dis.connected, false); assert.match(dis.note, /not connected yet/);
  assert.ok(sb.loggedOut); assert.ok(!fs.existsSync(sb.cfg.authDir), 'B\'s keys are gone');
  assert.strictEqual((await s.call('POST', '/api/wa/connect', {}, cc)).status, 200, 'a slot is free again');
  // restart: A (keys on disk) reconnects by itself, B (disconnected) does not
  await new Promise((res) => s.srv.close(res));
  const F2 = fakeSockets(), H2 = fakeWeb(() => {});
  const s2 = await boot(t, env, { dir, server: { webTransport: (cfg) => (cfg.authDir === path.join(dir, 'wa-web-auth') ? H2.factory(cfg) : F2.factory(cfg)) } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(F2.socks.has(path.join(dir, 'wa-web-auth-shops', idA)), 'A reconnected');
  assert.ok(!F2.socks.has(path.join(dir, 'wa-web-auth-shops', idB)));
  void s2;
});

test('the page: one entry screen (Login / Register new shop) for anyone not logged in, and the WhatsApp box', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html'), 'utf8');
  assert.match(html, /Register new shop/); assert.match(html, /api\/auth\/register/);
  assert.match(html, /showGate\(entryCard\('login'\)\)/);
  assert.match(html, /WhatsApp not connected yet/); assert.match(html, /Connect WhatsApp/); assert.match(html, /Disconnect WhatsApp/);
});
