'use strict';
// Storage adapter for the shop's khata (one state object per shop).
//   file store (default): data/<shop>.json, rewritten atomically on every change.
//   pg store (DATABASE_URL set): table shop_state(shop_id, state jsonb, updated_at), one row per shop.
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

// Picks the store from the environment. Async because the database needs a connection first.
async function openStore(env, dataDir, shopId) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL, env.SHOP_ID || shopId);
  return createFileStore(dataDir, shopId);
}

module.exports = { createFileStore, createPgStore, openStore, DDL, UPSERT };
