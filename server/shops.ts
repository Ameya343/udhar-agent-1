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

async function openRegistry(env: Env, dataDir: string, opts?: { pg?: typeof PgModule; log?: (m: string) => void }): Promise<Registry> {
  if (!env.DATABASE_URL) return createFileRegistry(dataDir);
  try { return await createPgRegistry(env.DATABASE_URL, opts); }
  catch (e: any) { (opts && opts.log || console.log)('Shop registry: database not reachable (' + String(e && (e.code || e.name) || 'error') + '); using shops.registry.json'); return createFileRegistry(dataDir); }
}

export { createFileRegistry, createPgRegistry, openRegistry, newShopId, validShopId };
