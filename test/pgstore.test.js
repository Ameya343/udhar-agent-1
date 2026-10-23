'use strict';
// Needs a scratch Postgres: TEST_DATABASE_URL=postgres://user:pw@localhost/db. Skipped when unset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../core/agent-core.js');
const { createPgStore, createFileStore } = require('../server/store.js');
const { createServer } = require('../server/server.js');
const imp = require('../scripts/import-json-to-pg.js');

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'TEST_DATABASE_URL not set';
const TODAY = '2025-01-15';

async function clean() {
  const pg = require('pg'); const p = new pg.Pool({ connectionString: URL });
  await p.query('DROP TABLE IF EXISTS shop_state'); await p.end();
}
const fresh = (id) => C.freshShop(id, TODAY);

test('file store stays the default and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const s = createFileStore(dir, 'gupta');
  assert.strictEqual(s.load(), null);
  const st = fresh('gupta'); s.save(st);
  assert.deepStrictEqual(s.load(), JSON.parse(JSON.stringify(st)));
});

test('pg: save/load round-trip', { skip }, async () => {
  await clean();
  const a = await createPgStore(URL, 'gupta');
  assert.strictEqual(a.load(), null);
  const st = fresh('gupta'); a.save(st); await a.flush(); await a.close();
  const b = await createPgStore(URL, 'gupta');
  assert.deepStrictEqual(b.load(), JSON.parse(JSON.stringify(st)));
  await b.close();
});

test('pg: two shops are isolated', { skip }, async () => {
  await clean();
  const a = await createPgStore(URL, 'gupta'), b = await createPgStore(URL, 'sharma');
  const sa = fresh('gupta'), sb = fresh('sharma'); sa.marker = 'A'; sb.marker = 'B';
  a.save(sa); b.save(sb); await a.flush(); await b.flush();
  sa.marker = 'A2'; a.save(sa); await a.flush();
  await a.close(); await b.close();
  const a2 = await createPgStore(URL, 'gupta'), b2 = await createPgStore(URL, 'sharma');
  assert.strictEqual(a2.load().marker, 'A2'); assert.strictEqual(b2.load().marker, 'B');
  await a2.close(); await b2.close();
});

test('pg: server state survives a restart (crash safety), file untouched', { skip }, async () => {
  await clean();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const env = { SHOP: 'gupta', DATA_DIR: dir };
  const s1 = await createPgStore(URL, 'gupta');
  const srv1 = createServer({ env, store: s1, today: () => TODAY });
  await s1.flush(); // the server wrote its fresh khata
  const s2 = await createPgStore(URL, 'gupta');
  const st = s2.load(); assert.ok(st && st.shop, 'khata persisted by the server');
  st.marker = 'after-change'; s2.save(st); await s2.flush(); // abrupt stop: no close()
  const s3 = await createPgStore(URL, 'gupta');
  const srv2 = createServer({ env, store: s3, today: () => TODAY });
  assert.strictEqual(s3.load().marker, 'after-change');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  srv1.close(); srv2.close();
});

test('pg: failed write is reported, not thrown, and the next write recovers', { skip }, async () => {
  await clean();
  const s = await createPgStore(URL, 'gupta');
  const circ = {}; circ.x = circ;
  assert.throws(() => s.save(circ)); // unserialisable state is rejected before queueing
  s.save(fresh('gupta')); await s.flush(); assert.strictEqual(s.lastError, null);
  await s.close();
});

test('import script: dry run writes nothing, --apply imports, no overwrite without --force', { skip }, async () => {
  await clean();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const f = path.join(dir, 'k.json'); const st = fresh('gupta'); st.marker = 'imp'; fs.writeFileSync(f, JSON.stringify(st));
  const env = { DATABASE_URL: URL }, lines = []; const out = (l) => lines.push(l);
  assert.strictEqual(await imp.run([f, 'shopx'], env, out), 0);
  let s = await createPgStore(URL, 'shopx'); assert.strictEqual(s.load(), null); await s.close();
  assert.strictEqual(await imp.run([f, 'shopx', '--apply'], env, out), 0);
  s = await createPgStore(URL, 'shopx'); assert.strictEqual(s.load().marker, 'imp'); await s.close();
  st.marker = 'v2'; fs.writeFileSync(f, JSON.stringify(st));
  assert.strictEqual(await imp.run([f, 'shopx', '--apply'], env, out), 1);
  assert.strictEqual(await imp.run([f, 'shopx', '--apply', '--force'], env, out), 0);
  s = await createPgStore(URL, 'shopx'); assert.strictEqual(s.load().marker, 'v2'); await s.close();
  assert.ok(!lines.join('\n').includes(URL));
  fs.writeFileSync(f, '{}'); assert.strictEqual(await imp.run([f, 'shopx'], env, out), 1);
});
