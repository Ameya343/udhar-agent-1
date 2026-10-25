// Storage adapter for the shop's khata (one state object per shop).
//   file store (default): data/<shop>.json, rewritten atomically on every change.
//   pg store (DATABASE_URL set): table shop_state(shop_id, state jsonb, updated_at), one row per shop.
//   pg-tables store (DATABASE_URL and STORE=pg-tables): normalised tables with Row-Level Security (db/migrations, server/tables.js).
//   pg-schema store (DATABASE_URL and STORE=pg-schema): registry public.shops plus one schema per shop (server/schema.js).
// Both expose: load() -> state|null, save(state), flush() -> Promise, close() -> Promise.
import fs = require('fs');
import path = require('path');
import type * as PgModule from 'pg';
import type { State } from '../core/types';
import type { Queryable, Snapshot } from './tables';

type Pg = typeof PgModule;
type Log = (msg: string) => void;
/** Runs fn(client) in one transaction scoped to the shop. */
type WithShop = <R>(fn: (c: Queryable) => Promise<R>) => Promise<R>;
/** What every store gives the server: load() -> state|null, save(state), flush(), close(). */
export interface Store {
  readonly kind: string;
  readonly lastError?: string | null;
  readonly dualWrite?: boolean;
  readonly fallback?: string | null;
  readonly schema?: string;
  readonly withShop?: WithShop;
  load(): State | null;
  save(state: State): void;
  flush(): Promise<unknown>;
  close(): Promise<unknown>;
  reconnect?(): Promise<boolean>;
}
export interface PgStoreOpts { pg?: Pg; migrate?: boolean }
export interface OpenStoreOpts { pg?: Pg; log?: Log; delays?: number[]; reconnectMs?: number }
type Env = Record<string, string | undefined>;
type Maker = (databaseUrl: string, shopId: string, opts?: PgStoreOpts) => Promise<Store>;

function createFileStore(dataDir: string, shopId: string) {
  const file = path.join(dataDir, shopId + '.json');
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    kind: 'file',
    load() {
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; } // no khata yet
      try { return JSON.parse(raw); } catch (e) {
        // a damaged khata is kept aside and the server refuses to start, never seeds a demo shop over it (KAN-85)
        const keep = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
        try { fs.copyFileSync(file, keep); } catch (e2) {}
        throw new Error('khata file ' + file + ' is damaged (' + (e as Error).message + '); copy kept at ' + keep + '. Fix or restore it from a backup, then start again.');
      }
    },
    save(state: State) {
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

function loadPg(): Pg {
  try { return require('pg'); } catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is not installed (run npm install)'); }
}

// Opens the pool, creates the table, reads the shop's row. Callers keep the state in memory (as with the file store);
// save() snapshots it synchronously and writes it through in order, each write one atomic statement.
async function createPgStore(databaseUrl: string, shopId: string, opts?: PgStoreOpts | null): Promise<Store> {
  opts = opts || {};
  const pg = opts.pg || loadPg();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  await pool.query(DDL);
  const r = await pool.query('SELECT state FROM shop_state WHERE shop_id = $1', [shopId]);
  const initial = r.rows.length ? r.rows[0].state : null;
  let chain: Promise<unknown> = Promise.resolve(), lastError: string | null = null;
  return {
    kind: 'pg',
    get lastError() { return lastError; },
    load() { return initial; },
    save(state: State) {
      const json = JSON.stringify(state);
      chain = chain.then(() => pool.query(UPSERT, [shopId, json])).then(() => { lastError = null; }, (e) => { lastError = String(e.message || e).slice(0, 200); console.error('Database save failed: ' + lastError); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); }
  };
}

// Dates come back as 'YYYY-MM-DD' strings and numerics as strings (turned into numbers by the mapper), never Date objects.
function pgTypes(pg: Pg) {
  // the any matches pg's own CustomTypesConfig signature (overloaded per format)
  return { getTypeParser: ((oid: number, fmt?: 'text' | 'binary') => (oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, fmt))) as any };
}

// Normalised tables. Migrations run on start. Each save() is one transaction for the shop: tables whose rows changed
// are replaced for that shop, items are upserted. The connection is scoped with app.shop_id, so RLS limits it to the shop.
async function createPgTablesStore(databaseUrl: string, shopId: string, opts?: PgStoreOpts | null): Promise<Store> {
  opts = opts || {};
  const pg = opts.pg || loadPg();
  const T: typeof import('./tables') = require('./tables.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10000, types: pgTypes(pg) });
  pool.on('error', () => {});
  if (opts.migrate !== false) await (require('../scripts/migrate.js') as typeof import('../scripts/migrate')).migrate(pool);
  const tx = async <R>(fn: (c: Queryable) => Promise<R>): Promise<R> => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  };
  const initial = await tx((c) => T.readShop(c, shopId)) as State | null;
  let chain: Promise<unknown> = Promise.resolve(), lastError: string | null = null, last: Snapshot = {};
  if (initial) last = await tx((c) => T.writeShop(c, shopId, initial, {})).catch(() => ({})); // baseline, so the first save writes only what changed
  return {
    kind: 'pg-tables',
    get lastError() { return lastError; },
    load() { return initial; },
    save(state: State) {
      const snap = JSON.parse(JSON.stringify(state));
      chain = chain.then(() => tx((c) => T.writeShop(c, shopId, snap, last))).then((n) => { last = n; lastError = null; },
        (e) => { last = {}; lastError = String(e.message || e).slice(0, 200); console.error('Database save failed: ' + lastError); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); },
    withShop: <R>(fn: (c: Queryable) => Promise<R>) => tx(async (c) => { await c.query("SELECT set_config('app.shop_id', $1, true)", [shopId]); return fn(c); })
  };
}

// One schema per shop. Migrations (for the public.shops registry) run on start, then the shop's schema is created if
// it does not exist yet. Saves follow the pg-tables rules (one transaction, only changed tables rewritten).
async function createPgSchemaStore(databaseUrl: string, shopId: string, opts?: PgStoreOpts | null): Promise<Store> {
  opts = opts || {};
  const pg = opts.pg || loadPg();
  const S: typeof import('./schema') = require('./schema.js');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10000, types: pgTypes(pg) });
  pool.on('error', () => {});
  const tx = async <R>(fn: (c: Queryable) => Promise<R>): Promise<R> => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  };
  let schema: string, initial: State | null;
  try {
    if (opts.migrate !== false) await (require('../scripts/migrate.js') as typeof import('../scripts/migrate')).migrate(pool);
    schema = await tx((c) => S.ensureShop(c, shopId));
    initial = await tx((c) => S.readShop(c, shopId, schema)) as State | null;
  } catch (e) { await pool.end().catch(() => {}); throw e; }
  let chain: Promise<unknown> = Promise.resolve(), lastError: string | null = null, last: Snapshot = {};
  if (initial) last = await tx((c) => S.writeShop(c, shopId, schema, initial, {})).catch(() => ({}));
  return {
    kind: 'pg-schema',
    schema,
    get lastError() { return lastError; },
    load() { return initial; },
    save(state: State) {
      const snap = JSON.parse(JSON.stringify(state));
      chain = chain.then(() => tx((c) => S.writeShop(c, shopId, schema, snap, last))).then((n) => { last = n; lastError = null; },
        (e) => { last = {}; lastError = String(e.message || e).slice(0, 200); console.error('Database save failed: ' + lastError); });
    },
    flush() { return chain; },
    close() { return chain.then(() => pool.end()); },
    // runs fn(client) in a transaction with search_path set to this shop's schema only
    withShop: <R>(fn: (c: Queryable) => Promise<R>) => tx(async (c) => { await c.query("SELECT set_config('app.shop_id', $1, true)", [shopId]); await c.query("SELECT set_config('search_path', $1, true)", ['"' + schema + '"']); return fn(c); })
  };
}

const MAKERS: Record<string, Maker> = { 'pg-tables': createPgTablesStore, 'pg-schema': createPgSchemaStore };
function makerFor(store: string | undefined): Maker { return MAKERS[store!] || createPgStore; }

// Picks the store from the environment. Async because the database needs a connection first.
// SAFE mode (DUAL_WRITE_JSON=1 with a database):
//   - every save also rewrites data/<shop>.json, so the file is always a complete, current backup;
//   - if the database cannot be reached at start, the server runs on that JSON file (never on an empty khata) and
//     leaves a marker file; on the next start with the database back, the newer JSON khata is pushed into it first;
//   - if the database has no khata for the shop yet but the JSON file has one, the JSON khata is used and written in.
// Without DUAL_WRITE_JSON a database that is down at start still falls back to an existing JSON khata rather than
// starting empty; with no JSON khata either, start fails (better than seeding a demo shop over a live one).
// AggregateError (net.connect tried every address of the host and all failed) has an empty message: name the codes.
// e is whatever was thrown (Error, AggregateError, a pg error with code/address, or anything else).
function describe(e: any): string {
  if (!e) return 'unknown error';
  const parts = (e.errors || []).map((x: any) => (x && (x.code || x.message)) + (x && x.address ? ' ' + x.address : '')).filter(Boolean);
  const msg = e.message || e.code || e.name || String(e);
  return (parts.length ? (e.name || 'Error') + (e.message ? ': ' + e.message : '') + ' [' + parts.join(', ') + ']' : String(msg)).slice(0, 200);
}

function delaysFrom(env: Env, opts: OpenStoreOpts): number[] {
  if (opts.delays) return opts.delays;
  // default ~37 s of waiting (plus each attempt's own connect timeout): covers a Neon compute waking from suspend and
  // a container whose network is not fully up yet at the moment the server starts
  const raw = env.DB_START_RETRY_MS != null ? String(env.DB_START_RETRY_MS) : '2000,5000,10000,20000';
  return raw.split(',').filter((x) => x.trim() !== '').map((x) => +x).filter((x) => Number.isFinite(x) && x >= 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectDb(env: Env, key: string, opts: OpenStoreOpts, log: Log): Promise<Store> {
  const make = makerFor(env.STORE);
  const delays = delaysFrom(env, opts);
  for (let i = 0; ; i++) {
    try { return await make(env.DATABASE_URL!, key, { pg: opts.pg }); }
    catch (e) {
      if (i >= delays.length) throw e;
      log('Database connect attempt ' + (i + 1) + ' failed (' + describe(e) + '); retrying in ' + Math.round(delays[i] / 1000) + ' s');
      await sleep(delays[i]);
    }
  }
}

// The database store as the server sees it: copies a newer JSON khata in first when needed (marker / empty db).
async function attachDb(db: Store, file: Store, local: State | null, marker: string, dual: boolean, key: string, log: Log, why?: string): Promise<Store> {
  let initial = db.load();
  let push = false;
  if (fs.existsSync(marker) && local && local.shop) { initial = local; push = true; log(why || 'Database is back: loading the newer JSON khata into it'); }
  else if ((!initial || !initial.shop) && local && local.shop) { initial = local; push = true; log('Database has no khata for ' + key + ': loading the JSON khata into it'); }
  if (push) {
    db.save(initial!);
    await db.flush();
    if (db.lastError) { await db.close().catch(() => {}); throw new Error('could not copy the JSON khata into the database: ' + db.lastError); }
    try { fs.unlinkSync(marker); } catch (e) {}
  }
  return {
    kind: db.kind,
    dualWrite: dual,
    fallback: null,
    get lastError() { return db.lastError; },
    load() { return initial; },
    save(state: State) {
      if (dual) { try { file.save(state); } catch (e: any) { console.error('JSON backup write failed: ' + String(e.message || e).slice(0, 200)); } }
      db.save(state);
    },
    flush() { return db.flush(); },
    close() { return db.close(); },
    withShop: db.withShop
  };
}

// Picks the store from the environment. Async because the database needs a connection first.
// SAFE mode (DUAL_WRITE_JSON=1 with a database):
//   - every save also rewrites data/<shop>.json, so the file is always a complete, current backup;
//   - the first connection is retried with backoff (DB_START_RETRY_MS, default 2,5,10,20 s) before giving up;
//   - if the database still cannot be reached, the server runs on that JSON file (never on an empty khata), leaves a
//     marker file and keeps retrying in the background (DB_RECONNECT_MS, default 60 s, 0 = off). When the database
//     answers, the current khata is pushed into it and the store switches to the database without a restart;
//   - if the database has no khata for the shop yet but the JSON file has one, the JSON khata is used and written in.
// Without DUAL_WRITE_JSON a database that is down at start still falls back to an existing JSON khata rather than
// starting empty; with no JSON khata either, start fails (better than seeding a demo shop over a live one).
async function openStore(env: Env, dataDir: string, shopId: string, opts?: OpenStoreOpts | null): Promise<Store> {
  opts = opts || {};
  const log = opts.log || console.log;
  if (!env.DATABASE_URL) return createFileStore(dataDir, shopId);
  const key = env.SHOP_ID || shopId;
  const file = createFileStore(dataDir, shopId);
  const marker = path.join(dataDir, shopId + '.db-fallback');
  const dual = env.DUAL_WRITE_JSON === '1';
  let db;
  try {
    db = await connectDb(env, key, opts, log);
  } catch (e) {
    const local = file.load();
    const why = describe(e);
    if (!local || !local.shop) throw new Error('database unreachable (' + why + ') and no JSON khata to fall back to');
    log('Database unreachable at start (' + why + '); running on the JSON file ' + path.join(dataDir, shopId + '.json'));
    try { fs.writeFileSync(marker, new Date().toISOString() + ' ' + why + '\n'); } catch (e2) {}
    return fallbackStore(env, file, local, marker, dual, key, opts, log, why);
  }
  return attachDb(db, file, file.load(), marker, dual, key, log);
}

// Runs on the JSON file and retries the database in the background; switches over once it is reachable.
function fallbackStore(env: Env, file: Store, local: State, marker: string, dual: boolean, key: string, opts: OpenStoreOpts, log: Log, why: string): Store {
  const every = opts.reconnectMs != null ? opts.reconnectMs : (env.DB_RECONNECT_MS != null ? +env.DB_RECONNECT_MS : 60000);
  let cur: Store | null = null, timer: ReturnType<typeof setTimeout> | null = null, closed = false, trying = false, latest = local, lastError: string | null = null;
  const self: Store & { reconnect(): Promise<boolean> } = {
    get kind() { return cur ? cur.kind : 'file'; },
    get dualWrite() { return cur ? cur.dualWrite : false; },
    get fallback() { return cur ? null : why; },
    get lastError() { return cur ? cur.lastError : lastError; },
    get withShop() { return cur ? cur.withShop : undefined; },
    load() { return local; },
    save(state: State) { latest = state; if (cur) return cur.save(state); file.save(state); },
    flush() { return cur ? cur.flush() : Promise.resolve(); },
    close() { closed = true; clearTimeout(timer!); return cur ? cur.close() : Promise.resolve(); },
    // one background attempt; resolves true once the store is on the database
    async reconnect() {
      if (cur) return true;
      if (closed || trying) return false;
      trying = true;
      try {
        const db = await connectDb(env, key, Object.assign({}, opts, { delays: [] }), log);
        if (closed) { await db.close().catch(() => {}); return false; }
        // the khata in memory (latest saved) is newer than anything the database has: the marker makes attachDb push it
        try { fs.writeFileSync(marker, new Date().toISOString() + ' reconnect\n'); } catch (e) {}
        cur = await attachDb(db, file, latest, marker, dual, key, log, 'Database reachable again: copied the current khata into it, now saving to the database');
        lastError = null;
        return true;
      } catch (e) {
        lastError = describe(e);
        return false;
      } finally { trying = false; }
    }
  };
  const tick = () => {
    if (closed || cur) return;
    timer = setTimeout(() => { self.reconnect().then((ok) => { if (!ok) tick(); }); }, every);
    if (timer.unref) timer.unref();
  };
  if (every > 0) tick();
  return self;
}

export { describe, delaysFrom, createFileStore, createPgStore, createPgTablesStore, createPgSchemaStore, makerFor, pgTypes, openStore, DDL, UPSERT };
