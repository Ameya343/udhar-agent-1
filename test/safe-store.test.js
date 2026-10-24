'use strict';
// SAFE mode: DATABASE_URL + DUAL_WRITE_JSON=1. The JSON file stays a full backup; a database that is down at start
// never leaves the shop on an empty khata. The database parts need TEST_DATABASE_URL (a non-superuser scratch db).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { openStore, createFileStore } = require('../dist-server/server/store.js');
const { createServer } = require('../dist-server/server/server.js');

// its own schema, so it never races the other database test files (they drop and recreate tables in public)
const BASE = process.env.TEST_DATABASE_URL;
const URL = BASE && BASE + (BASE.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=safe_store');
const skip = URL ? false : 'TEST_DATABASE_URL not set';
const DOWN = 'postgres://nobody:x@127.0.0.1:1/none';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
const quiet = () => {};
async function reset() {
  const pg = require('pg'); const p = new pg.Pool({ connectionString: BASE });
  await p.query('DROP SCHEMA IF EXISTS safe_store CASCADE'); await p.query('CREATE SCHEMA safe_store'); await p.end();
}
function khata(note) { const s = C.freshShop('gupta', '2025-01-15'); s.shop.city = note; return s; }

test('database down at start: runs on the JSON khata, says so, leaves a marker', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('from-json'));
  const lines = [];
  for (const STORE of ['pg-tables', undefined]) {
    const s = await openStore({ DATABASE_URL: DOWN, STORE, DUAL_WRITE_JSON: '1' }, dir, 'gupta', { log: (l) => lines.push(l), delays: [], reconnectMs: 0 });
    assert.equal(s.kind, 'file');
    assert.ok(s.fallback);
    assert.equal(s.load().shop.city, 'from-json');
    await s.close();
  }
  assert.ok(lines.some((l) => /Database unreachable at start/.test(l)));
  assert.ok(fs.existsSync(path.join(dir, 'gupta.db-fallback')));
});

test('database down at start and no JSON khata: refuses to start (never seeds over a live shop)', async () => {
  await assert.rejects(openStore({ DATABASE_URL: DOWN, STORE: 'pg-tables', DUAL_WRITE_JSON: '1' }, tmpDir(), 'gupta', { log: quiet, delays: [] }), /no JSON khata/);
});

test('server on a fallback store reports it in /healthz', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('x'));
  const store = await openStore({ DATABASE_URL: DOWN, DUAL_WRITE_JSON: '1' }, dir, 'gupta', { log: quiet, delays: [], reconnectMs: 0 });
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: dir }, store, today: () => '2025-01-15' });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const j = await (await fetch('http://127.0.0.1:' + s.address().port + '/healthz')).json();
    assert.equal(j.storage.kind, 'file'); assert.ok(j.storage.fallback);
  } finally { s.close(); }
});

for (const STORE of ['pg-tables', undefined]) {
  const kind = STORE || 'pg';
  test(kind + ' + DUAL_WRITE_JSON: empty db takes the JSON khata; every save lands in both; marker pushes newer JSON', { skip }, async () => {
    await reset();
    const dir = tmpDir();
    const env = { DATABASE_URL: URL, STORE, DUAL_WRITE_JSON: '1' };
    createFileStore(dir, 'gupta').save(khata('json-first'));
    let s = await openStore(env, dir, 'gupta', { log: quiet });
    assert.equal(s.kind, kind); assert.equal(s.dualWrite, true);
    assert.equal(s.load().shop.city, 'json-first', 'empty database never starts empty');
    const st = s.load(); st.shop.city = 'saved-both'; s.save(st); await s.flush(); assert.equal(s.lastError, null); await s.close();
    assert.equal(createFileStore(dir, 'gupta').load().shop.city, 'saved-both', 'JSON backup written');
    s = await openStore({ DATABASE_URL: URL, STORE }, tmpDir(), 'gupta', { log: quiet });
    assert.equal(s.load().shop.city, 'saved-both', 'database written'); await s.close();
    // the database was down for a while: the JSON file moved on, the marker says so
    createFileStore(dir, 'gupta').save(khata('offline-edit'));
    fs.writeFileSync(path.join(dir, 'gupta.db-fallback'), 'x');
    s = await openStore(env, dir, 'gupta', { log: quiet });
    assert.equal(s.load().shop.city, 'offline-edit'); await s.close();
    assert.ok(!fs.existsSync(path.join(dir, 'gupta.db-fallback')));
    s = await openStore({ DATABASE_URL: URL, STORE }, tmpDir(), 'gupta', { log: quiet });
    assert.equal(s.load().shop.city, 'offline-edit'); await s.close();
  });
}

// A pg stand-in for the jsonb store: the first `failures` connections fail like net.connect over IPv6+IPv4 does.
function flakyPg(failures) {
  const rows = new Map(); let n = 0;
  const agg = () => { const e = new AggregateError([Object.assign(new Error('x'), { code: 'ENETUNREACH', address: '2406::1' }), Object.assign(new Error('y'), { code: 'ETIMEDOUT', address: '13.0.0.1' })], ''); return e; };
  class Pool {
    on() {}
    async query(sql, args) {
      if (n < failures) { n++; throw agg(); }
      if (/^SELECT/.test(sql)) return { rows: rows.has(args[0]) ? [{ state: rows.get(args[0]) }] : [] };
      if (/^INSERT/.test(sql)) rows.set(args[0], JSON.parse(args[1]));
      return { rows: [] };
    }
    async end() {}
  }
  return { Pool, rows, fail(k) { failures = n + k; }, get attempts() { return n; } };
}

test('describe names every address of an AggregateError (its message is empty)', () => {
  const { describe } = require('../dist-server/server/store.js');
  const e = new AggregateError([Object.assign(new Error(''), { code: 'ENETUNREACH', address: '2406::1' }), Object.assign(new Error(''), { code: 'ETIMEDOUT', address: '13.0.0.1' })], '');
  assert.equal(describe(e), 'AggregateError [ENETUNREACH 2406::1, ETIMEDOUT 13.0.0.1]');
});

test('start retries the database with backoff before falling back (Neon cold start)', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('json'));
  const pg = flakyPg(2); const lines = [];
  const s = await openStore({ DATABASE_URL: 'postgres://x@h/db', DUAL_WRITE_JSON: '1' }, dir, 'gupta', { pg, delays: [5, 5, 5], log: (l) => lines.push(l) });
  assert.equal(s.kind, 'pg'); assert.equal(s.fallback, null);
  assert.equal(lines.filter((l) => /connect attempt \d failed \(AggregateError \[ENETUNREACH/.test(l)).length, 2);
  assert.equal(pg.rows.get('gupta').shop.city, 'json', 'empty database took the JSON khata');
  await s.close();
});

test('database still down after retries: JSON fallback, then switches to the database in the background', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('json'));
  const pg = flakyPg(1000);
  const s = await openStore({ DATABASE_URL: 'postgres://x@h/db', DUAL_WRITE_JSON: '1' }, dir, 'gupta', { pg, delays: [1], reconnectMs: 0, log: quiet });
  assert.equal(s.kind, 'file'); assert.match(s.fallback, /ENETUNREACH/);
  assert.ok(fs.existsSync(path.join(dir, 'gupta.db-fallback')));
  const st = s.load(); st.shop.city = 'edited-offline'; s.save(st);
  assert.equal(createFileStore(dir, 'gupta').load().shop.city, 'edited-offline', 'offline saves go to the JSON file');
  assert.equal(await s.reconnect(), false, 'still down'); assert.match(s.lastError, /AggregateError/);
  pg.fail(0);
  assert.equal(await s.reconnect(), true);
  assert.equal(s.kind, 'pg'); assert.equal(s.fallback, null); assert.equal(s.dualWrite, true);
  assert.equal(pg.rows.get('gupta').shop.city, 'edited-offline', 'current khata copied into the database');
  assert.ok(!fs.existsSync(path.join(dir, 'gupta.db-fallback')), 'marker cleared');
  st.shop.city = 'after-switch'; s.save(st); await s.flush();
  assert.equal(pg.rows.get('gupta').shop.city, 'after-switch');
  assert.equal(createFileStore(dir, 'gupta').load().shop.city, 'after-switch', 'dual write continues');
  await s.close();
});

test('background reconnect timer runs on its own and stops on close', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('json'));
  const pg = flakyPg(2);
  const s = await openStore({ DATABASE_URL: 'postgres://x@h/db' }, dir, 'gupta', { pg, delays: [1], reconnectMs: 10, log: quiet });
  assert.equal(s.kind, 'file');
  for (let i = 0; i < 100 && s.kind !== 'pg'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.kind, 'pg');
  await s.close();
  const s2 = await openStore({ DATABASE_URL: 'postgres://x@h/db' }, dir, 'gupta', { pg: flakyPg(1000), delays: [], reconnectMs: 10, log: quiet });
  await s2.close(); // no timer left behind: the test run would hang otherwise
});

test('DB_START_RETRY_MS sets the backoff; empty means one attempt', async () => {
  const dir = tmpDir();
  createFileStore(dir, 'gupta').save(khata('json'));
  const pg = flakyPg(1000);
  const s = await openStore({ DATABASE_URL: 'postgres://x@h/db', DB_START_RETRY_MS: '' , DB_RECONNECT_MS: '0' }, dir, 'gupta', { pg, log: quiet });
  assert.equal(pg.attempts, 1); assert.equal(s.kind, 'file'); await s.close();
  const pg2 = flakyPg(1000);
  const s2 = await openStore({ DATABASE_URL: 'postgres://x@h/db', DB_START_RETRY_MS: '1,1', DB_RECONNECT_MS: '0' }, dir, 'gupta', { pg: pg2, log: quiet });
  assert.equal(pg2.attempts, 3); await s2.close();
});
