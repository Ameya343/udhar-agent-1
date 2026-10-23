'use strict';
// Storage adapter for the shop's khata (one state object per shop).
//   file store (default): data/<shop>.json, rewritten atomically on every change.
//   pg store (DATABASE_URL set): table shop_state(shop_id, state jsonb, updated_at), one row per shop.
//   pg-tables store (DATABASE_URL and STORE=pg-tables): normalised tables with Row-Level Security (db/migrations, server/tables.js).
// Both expose: load() -> state|null, save(state), flush() -> Promise, close() -> Promise.
const fs = require('fs');
const path = require('path');

function createFileStore(dataDir, shopId) {
  const file = path.join(dataDir, shopId + '.json');
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    kind: 'file',
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    save(state) {
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
    flush() { return Promise.resolve(); },
    close() { return Promise.resolve(); }
  };
}

const DDL = 'CREATE TABLE IF NOT EXISTS shop_state (shop_id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())';
const UPSERT = 'INSERT INTO shop_state (shop_id, state, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (shop_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()';

function loadPg() {
  try { return require('pg'); } catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is not installed (run npm install)'); }
}

// Opens the pool, creates the table, reads the shop's row. Callers keep the state in memory (as with the file store);
// save() snapshots it synchronously and writes it through in order, each write one atomic statement.
async function createPgStore(databaseUrl, shopId, opts) {
  opts = opts || {};
  const pg = opts.pg || loadPg();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  pool.on('error', () => {});
  await pool.query(DDL);
  const r = await pool.query('SELECT state FROM shop_state WHERE shop_id = $1', [shopId]);
  const initial = r.rows.length ? r.rows[0].state : null;
  let chain = Promise.resolve(), lastError = null;
  return {
    kind: 'pg',
    get lastError() { return lastError; },
    load() { return initial; },
    save(state) {
      const json = JSON.stringify(state);
      chain = chain.then(() => pool.query(UPSERT, [shopId, json])).then(() => { lastError = null; }, (e) => { lastError = String(e.message || e).slice(0, 200); console.error('Database save failed: ' + lastError); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); }
  };
}

// Dates come back as 'YYYY-MM-DD' strings and numerics as strings (turned into numbers by the mapper), never Date objects.
function pgTypes(pg) {
  return { getTypeParser: (oid, fmt) => (oid === 1082 ? (v) => v : pg.types.getTypeParser(oid, fmt)) };
}

// Normalised tables. Migrations run on start. Each save() is one transaction for the shop: tables whose rows changed
// are replaced for that shop, items are upserted. The connection is scoped with app.shop_id, so RLS limits it to the shop.
async function createPgTablesStore(databaseUrl, shopId, opts) {
  opts = opts || {};
  const pg = opts.pg || loadPg();
  const T = require('./tables.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, types: pgTypes(pg) });
  pool.on('error', () => {});
  if (opts.migrate !== false) await require('../scripts/migrate.js').migrate(pool);
  const tx = async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  };
  const initial = await tx((c) => T.readShop(c, shopId));
  let chain = Promise.resolve(), lastError = null, last = {};
  if (initial) last = await tx((c) => T.writeShop(c, shopId, initial, {})).catch(() => ({})); // baseline, so the first save writes only what changed
  return {
    kind: 'pg-tables',
    get lastError() { return lastError; },
    load() { return initial; },
    save(state) {
      const snap = JSON.parse(JSON.stringify(state));
      chain = chain.then(() => tx((c) => T.writeShop(c, shopId, snap, last))).then((n) => { last = n; lastError = null; },
        (e) => { last = {}; lastError = String(e.message || e).slice(0, 200); console.error('Database save failed: ' + lastError); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); },
    withShop: (fn) => tx(async (c) => { await c.query("SELECT set_config('app.shop_id', $1, true)", [shopId]); return fn(c); })
  };
}

// Picks the store from the environment. Async because the database needs a connection first.
async function openStore(env, dataDir, shopId) {
  if (env.DATABASE_URL && env.STORE === 'pg-tables') return createPgTablesStore(env.DATABASE_URL, env.SHOP_ID || shopId);
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL, env.SHOP_ID || shopId);
  return createFileStore(dataDir, shopId);
}

module.exports = { createFileStore, createPgStore, createPgTablesStore, pgTypes, openStore, DDL, UPSERT };
