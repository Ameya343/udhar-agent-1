// The shop registry: which self-registered shop an owner's phone number belongs to (one owner account = one shop).
// The instance's own shop (SHOP / SHOP_ID, e.g. gupta) is not in here; its owner login stays exactly where it was.
// Storage: data/shops.registry.json (default), or the table in db/migrations/003_shop_accounts.sql when DATABASE_URL is set.
import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import type * as PgModule from 'pg';

type Env = Record<string, string | undefined>;
export interface ShopAccount { id: string; phone: string; name: string; createdAt: string }
export interface Registry {
  readonly kind: string;
  list(): ShopAccount[];
  has(id: string): boolean;
  byPhone(phone: string): ShopAccount | null;
  /** Adds one shop; resolves once it is stored (a phone or id already taken rejects). */
  add(a: ShopAccount): Promise<void>;
  close(): Promise<unknown>;
}

/** A new shop id: "s" + 10 hex characters. Never a demo shop id, valid as a file name and as a schema name. */
function newShopId(): string { return 's' + crypto.randomBytes(5).toString('hex'); }
const ID_RE = /^s[0-9a-f]{10}$/;
const validShopId = (id: unknown) => typeof id === 'string' && ID_RE.test(id);

function memory(rows: ShopAccount[]) {
  const byId = new Map<string, ShopAccount>(), byPh = new Map<string, ShopAccount>();
  for (const r of rows) { byId.set(r.id, r); byPh.set(r.phone, r); }
  return {
    list: () => Array.from(byId.values()),
    has: (id: string) => byId.has(id),
    byPhone: (p: string) => byPh.get(p) || null,
    check(a: ShopAccount) {
      if (!validShopId(a.id)) throw new Error('bad shop id');
      if (byId.has(a.id) || byPh.has(a.phone)) throw Object.assign(new Error('taken'), { code: 409 });
    },
    put(a: ShopAccount) { byId.set(a.id, a); byPh.set(a.phone, a); }
  };
}

function createFileRegistry(dataDir: string): Registry {
  const file = path.join(dataDir, 'shops.registry.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let rows: ShopAccount[] = [];
  try { rows = (JSON.parse(fs.readFileSync(file, 'utf8')).shops || []).filter((r: ShopAccount) => r && validShopId(r.id)); } catch (e) {}
  const m = memory(rows);
  return {
    kind: 'file', list: m.list, has: m.has, byPhone: m.byPhone,
    async add(a) {
      m.check(a); m.put(a);
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ shops: m.list() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    close: () => Promise.resolve()
  };
}

const DDL = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '003_shop_accounts.sql'), 'utf8');

async function createPgRegistry(databaseUrl: string, opts?: { pg?: typeof PgModule }): Promise<Registry> {
  const pg: typeof PgModule = (opts && opts.pg) || require('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  let m: ReturnType<typeof memory>;
  try {
    await pool.query(DDL);
    const r = await pool.query('SELECT shop_id, owner_phone, shop_name, created_at FROM shop_accounts ORDER BY created_at');
    m = memory(r.rows.map((x: any) => ({ id: x.shop_id, phone: x.owner_phone, name: x.shop_name, createdAt: new Date(x.created_at).toISOString() })));
  } catch (e) { await pool.end().catch(() => {}); throw e; }
  return {
    kind: 'pg', list: m.list, has: m.has, byPhone: m.byPhone,
    async add(a) {
      m.check(a);
      // the unique index on owner_phone decides a race between two instances
      try { await pool.query('INSERT INTO shop_accounts (shop_id, owner_phone, shop_name, created_at) VALUES ($1,$2,$3,$4)', [a.id, a.phone, a.name, a.createdAt]); }
      catch (e: any) { throw e && e.code === '23505' ? Object.assign(new Error('taken'), { code: 409 }) : e; }
      m.put(a);
    },
    close: () => pool.end()
  };
}

// The database registry, retried at start like the khata store (DB_START_RETRY_MS). If it still cannot be reached, the
// shops already in shops.registry.json can log in, but registering a NEW shop is refused (503) until the database is
// back: a shop written only to the file is lost from the database and its owner is locked out after a restart (KAN-151).
// A background retry (DB_RECONNECT_MS, default 60 s) copies any file rows into the database and switches over.
async function openRegistry(env: Env, dataDir: string, opts?: { pg?: typeof PgModule; log?: (m: string) => void; delays?: number[]; reconnectMs?: number }): Promise<Registry> {
  if (!env.DATABASE_URL) return createFileRegistry(dataDir);
  const log = (opts && opts.log) || console.log;
  const { delaysFrom } = require('./store') as typeof import('./store');
  const delays: number[] = opts && opts.delays ? opts.delays : delaysFrom(env, {});
  const why = (e: any) => String(e && (e.code || e.name) || 'error');
  for (let i = 0; ; i++) {
    try { return await createPgRegistry(env.DATABASE_URL, opts); }
    catch (e: any) {
      if (i >= delays.length) { log('Shop registry: database not reachable (' + why(e) + '); new shops are paused until it is back, retrying in the background'); break; }
      log('Shop registry: database connect attempt ' + (i + 1) + ' failed (' + why(e) + '); retrying in ' + Math.round(delays[i] / 1000) + ' s');
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  const file = createFileRegistry(dataDir);
  let cur: Registry | null = null, closed = false, timer: ReturnType<typeof setTimeout> | null = null;
  const every = opts && opts.reconnectMs != null ? opts.reconnectMs : (env.DB_RECONNECT_MS != null ? +env.DB_RECONNECT_MS : 60000);
  const reg: Registry & { reconnect(): Promise<boolean> } = {
    get kind() { return cur ? cur.kind : 'file-fallback'; },
    list: () => (cur || file).list(),
    has: (id) => (cur || file).has(id),
    byPhone: (p) => (cur || file).byPhone(p),
    add(a) { return cur ? cur.add(a) : Promise.reject(Object.assign(new Error('database not reachable'), { code: 503 })); },
    close() { closed = true; clearTimeout(timer!); return cur ? cur.close() : Promise.resolve(); },
    async reconnect() {
      if (cur) return true;
      if (closed) return false;
      try {
        const db = await createPgRegistry(env.DATABASE_URL!, opts);
        // shops registered on the file before this fix (or by an older build) go into the database too
        for (const r of file.list()) if (!db.has(r.id) && !db.byPhone(r.phone)) await db.add(r).catch((e) => log('Shop registry: could not copy shop ' + r.id + ' (' + why(e) + ')'));
        if (closed) { await db.close().catch(() => {}); return false; }
        cur = db; log('Shop registry: database reachable again, now saving shops to the database');
        return true;
      } catch (e) { return false; }
    }
  };
  const tick = () => {
    if (closed || cur || !(every > 0)) return;
    timer = setTimeout(() => { reg.reconnect().then((ok) => { if (!ok) tick(); }); }, every);
    if (timer.unref) timer.unref();
  };
  tick();
  return reg;
}

export { createFileRegistry, createPgRegistry, openRegistry, newShopId, validShopId };
