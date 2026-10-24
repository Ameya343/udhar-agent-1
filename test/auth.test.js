// Owner login, first-owner setup, sessions, lockout, and the shop profile's GSTIN / PAN (format, checksum, masking, encryption).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const A = require('../dist-server/server/auth.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-auth-'));
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
const GSTIN = '27AAPFU0939F1ZV', PAN = 'ABCDE1234F';
const PROFILE = { shopName: 'Gupta Kirana', ownerName: 'Ramesh Gupta', address: '12 Main Road, Nagpur', gstRegistered: true, gstin: GSTIN };

// A live shop (REAL_CLOCK=1) seen from outside: every request carries x-forwarded-for, so nothing counts as the instance itself.
async function liveShop(envExtra, t) {
  const dir = tmpDir();
  const env = Object.assign({ SHOP: 'gupta', DATA_DIR: dir, REAL_CLOCK: '1', ADMIN_KEY: 'admin-secret' }, envExtra || {});
  const now = { t: Date.parse(TODAY + 'T10:00:00Z') };
  const srv = createServer({ env, today: () => TODAY, now: () => now.t });
  const base = await listen(srv);
  let ip = 1;
  const call = (method, p, body, headers) => fetch(base + p, { method, headers: Object.assign({ 'x-forwarded-for': '10.0.0.' + (headers && headers.ip || ip), 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  t.after(() => srv.close());
  return { srv, base, dir, now, call, nextIp() { ip++; } };
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('GSTIN: format, state code, embedded PAN and the check character', () => {
  for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '07AAGFF2194N1Z1', '33AAACH7409R1Z8']) assert.ok(A.checkGstin(g).ok, g);
  assert.strictEqual(A.checkGstin(' 27aapfu0939f1zv ').value, GSTIN, 'spaces and case are cleaned');
  assert.match(A.checkGstin('27AAPFU0939F1ZW').error, /check character/);
  assert.match(A.checkGstin('27AAPFU0939F1Z').error, /15 characters/);
  assert.match(A.checkGstin('27AAPF00939F1ZV').error, /format/, 'PAN part must be 5 letters, 4 digits, 1 letter');
  assert.match(A.checkGstin('27AAPFU0939F1XV').error, /format/, '14th character must be Z');
  const bad = '00AAPFU0939F1Z'; assert.match(A.checkGstin(bad + A.gstinCheckChar(bad)).error, /state code/);
  const st39 = '39AAPFU0939F1Z'; assert.match(A.checkGstin(st39 + A.gstinCheckChar(st39)).error, /state code/);
  assert.strictEqual(A.gstinCheckChar('27AAPFU0939F1Z'), 'V');
});

test('PAN format and masking', () => {
  assert.strictEqual(A.validPan('abcde1234f'), PAN);
  for (const p of ['ABCD1234F', 'ABCDE12345', '1BCDE1234F', 'ABCDE1234FG', '']) assert.strictEqual(A.validPan(p), null, p);
  assert.strictEqual(A.mask(GSTIN), 'XXXXXXXXXXXF1ZV');
  assert.strictEqual(A.mask(PAN), 'XXXXXX234F');
  assert.strictEqual(A.mask('1ZV9', 15), 'XXXXXXXXXXX1ZV9');
  assert.strictEqual(A.normPhone('+91 98765 43210'), '9876543210');
  assert.strictEqual(A.normPhone('09876543210'), '9876543210');
  assert.strictEqual(A.normPhone('12345'), null);
});

test('passwords: scrypt with salt, constant-time verify, never the plain text', () => {
  const h1 = A.hashPassword('meri-dukaan'), h2 = A.hashPassword('meri-dukaan');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notStrictEqual(h1, h2, 'random salt');
  assert.ok(!h1.includes('meri-dukaan'));
  assert.ok(A.verifyPassword('meri-dukaan', h1));
  assert.ok(!A.verifyPassword('meri-dukaaN', h1));
  assert.ok(!A.verifyPassword('x', 'garbage'));
  assert.match(A.passwordProblem('12345'), /at least 6/);
  assert.match(A.passwordProblem('111111'), /less obvious/);
  assert.strictEqual(A.passwordProblem('482913'), null, 'a 6-digit PIN is fine');
});

test('tax id at rest: AES-GCM with TAX_ID_KEY, plain marker without it', () => {
  const env = { TAX_ID_KEY: 'k1' };
  const s = A.sealTaxId(GSTIN, env);
  assert.match(s, /^enc:v1:/); assert.ok(!s.includes(GSTIN));
  assert.strictEqual(A.openTaxId(s, env), GSTIN);
  assert.strictEqual(A.openTaxId(s, { TAX_ID_KEY: 'other' }), null, 'wrong key cannot read it');
  assert.strictEqual(A.sealTaxId(PAN, {}), 'plain:' + PAN);
});

test('first owner setup needs ADMIN_KEY; only once; then the shop is locked to visitors', async (t) => {
  const s = await liveShop({ TAX_ID_KEY: 'tax-secret' }, t);
  let st = await (await s.call('GET', '/api/auth/status')).json();
  assert.deepStrictEqual([st.hasOwner, st.owner, st.live, st.adminKeySet, st.profile], [false, false, true, true, null]);
  const body = Object.assign({ phone: '98765 43210', password: 'chai-paani-9' }, PROFILE);
  assert.strictEqual((await s.call('POST', '/api/auth/setup', body)).status, 403, 'no admin key');
  assert.strictEqual((await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'wrong' }, body))).status, 403, 'wrong admin key');
  // validation errors before anything is created
  assert.match((await (await s.call('POST', '/api/auth/setup', Object.assign({}, body, { adminKey: 'admin-secret', gstin: '27AAPFU0939F1ZW' }))).json()).error, /check character/);
  assert.match((await (await s.call('POST', '/api/auth/setup', Object.assign({}, body, { adminKey: 'admin-secret', gstRegistered: false, gstin: '', pan: '' }))).json()).error, /PAN is required/);
  assert.match((await (await s.call('POST', '/api/auth/setup', Object.assign({}, body, { adminKey: 'admin-secret', password: '123' }))).json()).error, /at least 6/);
  s.nextIp(); // setup is limited to 5 tries a minute per visitor
  const r = await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret' }, body));
  assert.strictEqual(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^udhaar_owner=[A-Za-z0-9_-]{40,};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) assert.ok(sc.includes(flag), flag);
  const again = await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret' }, body, { phone: '9000000001' }));
  assert.strictEqual(again.status, 409, 'a second visitor cannot claim the shop');
  // logged in with the setup cookie
  st = await (await s.call('GET', '/api/auth/status', null, { cookie: cookieOf(r) })).json();
  assert.deepStrictEqual([st.hasOwner, st.owner, st.via, st.name], [true, true, 'session', 'Ramesh Gupta']);
  assert.strictEqual(st.profile.taxIdMasked, 'XXXXXXXXXXX' + GSTIN.slice(-4));
  assert.strictEqual(st.profile.verified, false);
  assert.strictEqual(st.profile.encrypted, true);
  // the stored file has the hash and the sealed tax id, never the password, the GSTIN or the session token
  const raw = fs.readFileSync(path.join(s.dir, 'gupta.auth.json'), 'utf8');
  assert.ok(!raw.includes('chai-paani-9') && !raw.includes(GSTIN) && !raw.includes(cookieOf(r).split('=')[1]));
  assert.strictEqual(fs.statSync(path.join(s.dir, 'gupta.auth.json')).mode & 0o077, 0, 'owner file is private');
  // nothing of it reaches the khata (page state, AI, WhatsApp)
  const khata = JSON.stringify(s.srv.getState());
  assert.ok(!khata.includes(GSTIN) && !khata.includes('scrypt'));
  assert.strictEqual(s.srv.auth.taxId(), GSTIN, 'server side can still read it with the key');
});

test('login, session gives the khata, logout ends it; no data without login or key (KAN-43)', async (t) => {
  const s = await liveShop({}, t);
  await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret', phone: '9876543210', password: 'chai-paani-9' }, PROFILE));
  const anon = await (await s.call('GET', '/api/state')).json();
  assert.strictEqual(anon.locked, true); assert.deepStrictEqual(anon.state.customers, []);
  assert.strictEqual((await s.call('GET', '/api/profile')).status, 403);
  assert.strictEqual((await s.call('POST', '/api/profile', PROFILE)).status, 403);
  assert.strictEqual((await s.call('POST', '/api/act', { action: 'nextDay' })).status, 403);
  assert.strictEqual((await s.call('GET', '/api/state', null, { cookie: 'udhaar_owner=forged-token' })).status, 200);
  assert.strictEqual((await (await s.call('GET', '/api/state', null, { cookie: 'udhaar_owner=forged-token' })).json()).locked, true, 'a made-up cookie is no session');

  assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'nope-nope' })).status, 401);
  const r = await s.call('POST', '/api/auth/login', { phone: '+91 98765 43210', password: 'chai-paani-9' });
  assert.strictEqual(r.status, 200);
  const ck = cookieOf(r);
  const full = await (await s.call('GET', '/api/state', null, { cookie: ck })).json();
  assert.strictEqual(full.locked, false); assert.ok(full.state.customers.length > 0);
  assert.strictEqual((await s.call('POST', '/api/act', { action: 'owner', args: { text: 'Sharma ji ka kitna baaki hai' } }, { cookie: ck })).status, 200, 'the logged-in owner can act');
  // the old ?key= owner link (x-admin-key) keeps working
  assert.strictEqual((await (await s.call('GET', '/api/state', null, { 'x-admin-key': 'admin-secret' })).json()).locked, false);
  // the session expires
  s.now.t += 8 * 86400e3;
  assert.strictEqual((await (await s.call('GET', '/api/state', null, { cookie: ck })).json()).locked, true, 'expired after 7 days');
  s.now.t -= 8 * 86400e3;
  const out = await s.call('POST', '/api/auth/logout', {}, { cookie: ck });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.strictEqual((await (await s.call('GET', '/api/state', null, { cookie: ck })).json()).locked, true, 'logged out on the server too');
});

test('lockout after 5 wrong passwords for a phone, then it opens again', async (t) => {
  const s = await liveShop({}, t);
  await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret', phone: '9876543210', password: 'chai-paani-9' }, PROFILE));
  for (let i = 0; i < 4; i++) { s.nextIp(); assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'wrong' + i })).status, 401); }
  s.nextIp();
  assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'wrong5' })).status, 429, 'fifth wrong try locks');
  s.nextIp();
  const locked = await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'chai-paani-9' });
  assert.strictEqual(locked.status, 429, 'even the right password waits while locked');
  assert.match((await locked.json()).error, /Try again in 15 minute/);
  s.now.t += 16 * 60e3;
  assert.strictEqual((await s.call('POST', '/api/auth/login', { phone: '9876543210', password: 'chai-paani-9' })).status, 200);
});

test('login is rate limited per visitor IP', async (t) => {
  const s = await liveShop({}, t);
  let last;
  for (let i = 0; i < 11; i++) last = await s.call('POST', '/api/auth/login', { phone: '90000000' + String(10 + i), password: 'whatever1' });
  assert.strictEqual(last.status, 429);
});

test('profile: GSTIN or PAN, exactly one; masked; kept when left empty; shop name updated', async (t) => {
  const s = await liveShop({}, t);
  const r = await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret', phone: '9876543210', password: 'chai-paani-9' }, PROFILE));
  const ck = { cookie: cookieOf(r) };
  let p = await (await s.call('POST', '/api/profile', Object.assign({}, PROFILE, { gstin: '' }), ck)).json();
  assert.strictEqual(p.profile.taxIdMasked.slice(-4), GSTIN.slice(-4), 'empty keeps the saved GSTIN');
  assert.strictEqual(p.profile.encrypted, false, 'no TAX_ID_KEY: not encrypted, and the page is told');
  const err = await s.call('POST', '/api/profile', Object.assign({}, PROFILE, { gstRegistered: false, gstin: '' }), ck);
  assert.strictEqual(err.status, 400, 'switching to not-registered needs a PAN');
  assert.match((await (await s.call('POST', '/api/profile', Object.assign({}, PROFILE, { gstRegistered: false, pan: 'ABCD1234F' }), ck)).json()).error, /ABCDE1234F/);
  p = await (await s.call('POST', '/api/profile', Object.assign({}, PROFILE, { shopName: 'Gupta General Store', gstRegistered: false, pan: 'abcde1234f', gstin: GSTIN }), ck)).json();
  assert.deepStrictEqual([p.profile.taxKind, p.profile.taxIdMasked, p.profile.gstRegistered], ['PAN', 'XXXXXX234F', false]);
  assert.ok(!JSON.stringify(p).includes(PAN) && !JSON.stringify(p).includes(GSTIN), 'only the last 4 go to the page');
  assert.strictEqual(s.srv.getState().shop.name, 'Gupta General Store');
  assert.strictEqual(s.srv.auth.taxId(), PAN, 'the GSTIN was replaced, not kept next to it');
  for (const k of ['shopName', 'ownerName', 'address']) assert.strictEqual((await s.call('POST', '/api/profile', Object.assign({}, PROFILE, { [k]: ' ' }), ck)).status, 400, k);
});

test('setup is refused when the server has no ADMIN_KEY; demo shops stay open', async (t) => {
  const s = await liveShop({ ADMIN_KEY: '' }, t);
  const r = await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: '', phone: '9876543210', password: 'chai-paani-9' }, PROFILE));
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /ADMIN_KEY/);
  const d = await liveShop({ REAL_CLOCK: '' }, t);
  assert.strictEqual((await (await d.call('GET', '/api/state')).json()).locked, false, 'a demo shop needs no login');
});

test('owner accounts survive a restart (file store); password change', async (t) => {
  const s = await liveShop({}, t);
  await s.call('POST', '/api/auth/setup', Object.assign({ adminKey: 'admin-secret', phone: '9876543210', password: 'chai-paani-9' }, PROFILE));
  const srv2 = createServer({ env: { SHOP: 'gupta', DATA_DIR: s.dir, REAL_CLOCK: '1', ADMIN_KEY: 'admin-secret' }, today: () => TODAY });
  const base2 = await listen(srv2); t.after(() => srv2.close());
  const post = (p, b, h) => fetch(base2 + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' }, h || {}), body: JSON.stringify(b) });
  const r = await post('/api/auth/login', { phone: '9876543210', password: 'chai-paani-9' });
  assert.strictEqual(r.status, 200);
  const ck = { cookie: cookieOf(r) };
  assert.strictEqual((await post('/api/auth/password', { current: 'bad', password: 'naya-pass-1' }, ck)).status, 401);
  assert.strictEqual((await post('/api/auth/password', { current: 'chai-paani-9', password: 'naya-pass-1' }, ck)).status, 200);
  assert.strictEqual((await post('/api/auth/login', { phone: '9876543210', password: 'naya-pass-1' })).status, 200);
});

test('the page has the login, setup and profile screens and says it is not government-verified', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html'), 'utf8');
  for (const s of ['id="gate"', 'Owner login', 'Not GST registered', 'not verified with the government', 'api/auth/login', 'api/auth/setup']) assert.ok(html.includes(s), s);
  assert.ok(!/Claude/.test(html.replace(/\/\*__CORE__\*\//, '')), 'the page never says Claude');
});
