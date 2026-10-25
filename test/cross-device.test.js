// What one device saves, every other device sees: the shop profile is read fresh from the server, the dashboard
// re-syncs, a new shop gets no demo town (KAN-152), and the shop registry never quietly lives on a file when a
// database is configured (KAN-151).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const { openRegistry, createFileRegistry } = require('../dist-server/server/shops.js');

fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-xdev-'));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)));
const SHOP = { shopName: 'UI Store', ownerName: 'Ravi Kumar', phone: '9811111111', password: 'ravi-pass' };

async function boot(t, o) {
  const dir = tmpDir();
  const env = Object.assign({ SHOP: 'gupta', DATA_DIR: dir, ADMIN_KEY: 'admin-secret', SHOP_CITY: 'Nagpur', REAL_CLOCK: '1' }, o && o.env);
  const srv = createServer(Object.assign({ env, today: () => '2026-10-25' }, o && o.server));
  const base = await listen(srv);
  t.after(() => new Promise((r) => srv.close(r)));
  const call = (method, p, body, headers) => fetch(base + p, { method, headers: Object.assign({ 'x-forwarded-for': '10.9.0.1', 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { srv, call, dir };
}

// a pg stand-in for the registry: "down" until up() is called; keeps the shop_accounts rows
function fakePg() {
  const rows = []; let down = true;
  class Pool {
    on() {}
    async end() {}
    async query(sql, args) {
      if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (/^SELECT/.test(sql)) return { rows: rows.slice() };
      if (/^INSERT/.test(sql)) { if (rows.some((r) => r.owner_phone === args[1])) throw Object.assign(new Error('dup'), { code: '23505' }); rows.push({ shop_id: args[0], owner_phone: args[1], shop_name: args[2], created_at: args[3] }); }
      return { rows: [] };
    }
  }
  return { pg: { Pool }, rows, up() { down = false; } };
}

test('KAN-151: a registry whose database is down at start refuses new shops (503), then reconnects and copies the file rows in', async () => {
  const dir = tmpDir(), logs = [];
  // a shop registered on the file earlier (an older build's fallback)
  await createFileRegistry(dir).add({ id: 's0123456789', phone: '9800000001', name: 'Old Shop', createdAt: '2026-10-24T10:00:00.000Z' });
  const f = fakePg();
  const reg = await openRegistry({ DATABASE_URL: 'postgres://x' }, dir, { pg: f.pg, log: (m) => logs.push(m), delays: [0, 0], reconnectMs: 0 });
  assert.strictEqual(reg.kind, 'file-fallback');
  assert.strictEqual(logs.filter((l) => /attempt \d failed/.test(l)).length, 2, 'retried before falling back');
  assert.ok(reg.has('s0123456789'), 'shops already on the file can still log in');
  await assert.rejects(reg.add({ id: 's1111111111', phone: '9800000002', name: 'New', createdAt: '2026-10-25T00:00:00.000Z' }), (e) => e.code === 503);
  f.up();
  assert.strictEqual(await reg.reconnect(), true);
  assert.strictEqual(reg.kind, 'pg');
  assert.deepStrictEqual(f.rows.map((r) => r.shop_id), ['s0123456789'], 'the file shop reached the database');
  await reg.add({ id: 's1111111111', phone: '9800000002', name: 'New', createdAt: '2026-10-25T00:00:00.000Z' });
  assert.strictEqual(f.rows.length, 2);
  await reg.close();
});

test('KAN-151: register answers 503 while the registry is on the fallback, and /healthz names the registry', async (t) => {
  const down = { kind: 'file-fallback', list: () => [], has: () => false, byPhone: () => null, add: () => Promise.reject(Object.assign(new Error('down'), { code: 503 })), close: () => Promise.resolve() };
  const s = await boot(t, { server: { registry: down } });
  const r = await s.call('POST', '/api/auth/register', SHOP);
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /database is not reachable/);
  assert.strictEqual((await (await s.call('GET', '/healthz')).json()).registry, 'file-fallback');
});

test('KAN-152: a newly registered shop has no city, even when the instance has SHOP_CITY', async (t) => {
  const s = await boot(t);
  const r = await s.call('POST', '/api/auth/register', SHOP);
  assert.strictEqual(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const st = await (await s.call('GET', '/api/state', null, { cookie })).json();
  assert.strictEqual(st.state.shop.name, 'UI Store');
  assert.strictEqual(st.state.shop.city, '');
  assert.strictEqual(s.srv.getState().shop.city, 'Nagpur', 'the instance shop keeps its town');
});

test('a UPI ID saved on one device is what every other device gets from the server', async (t) => {
  const s = await boot(t);
  const key = { 'x-admin-key': 'admin-secret' };
  const saved = await s.call('POST', '/api/profile', { shopName: 'Gupta Kirana Store', ownerName: 'Rajesh Gupta', upiId: 'harshit07@okicici', address: 'Sneh Nagar, Nagpur', gstRegistered: false, pan: 'ABCDE1234F' }, Object.assign({ 'x-forwarded-for': '10.9.0.1' }, key));
  assert.strictEqual(saved.status, 200);
  const other = Object.assign({ 'x-forwarded-for': '10.9.0.2' }, key);
  assert.strictEqual((await (await s.call('GET', '/api/state', null, other)).json()).state.shop.upiId, 'harshit07@okicici');
  assert.strictEqual((await (await s.call('GET', '/api/auth/status', null, other)).json()).profile.address, 'Sneh Nagar, Nagpur');
});

test('the dashboard never shows a cached profile form and re-syncs with the server', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'udhaar-agent-standalone.html'), 'utf8');
  assert.match(html, /function openPanel\(p\) \{ ui\.panel = p; \$\('panel'\)\.innerHTML = '';/, 'a reopened panel is built again, never the old form');
  assert.match(html, /\$\('profileBtn'\)\.addEventListener\('click', async \(\) => \{\s*closeMenu\(\);\s*await refreshFromServer\(\);/, 'the profile is read fresh');
  assert.match(html, /addEventListener\('visibilitychange'[^\n]*refreshFromServer/);
  assert.match(html, /setInterval\([^\n]*refreshFromServer\(\)/);
});
