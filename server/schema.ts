// STORE=pg-schema: one PostgreSQL schema per shop.
//   public.shops          registry, one row per shop (id, name, owner_phone, city, schema_name, created_at, ...)
//   "<shop>".customers     \
//   "<shop>".customer_txns  |  the shop's khata, no shop_id column: the schema is the shop.
//   "<shop>".traders        |  FKs stay inside the schema (txn -> customer, trader txn -> trader).
//   "<shop>".trader_txns    |
//   "<shop>".items          |  one row per item: customer_rate (selling), trader_rate (buying), units, updated_at
//   "<shop>".messages / orders / extras
// The object <-> rows mapping is the one pg-tables uses (server/tables.js stateToRows/rowsToState), so a load
// gives back exactly the object that was saved.
import T = require('./tables');
import type { Row, Queryable, LearnRate, Snapshot } from './tables';
/** Registry details for a new shop row. */
export interface ShopInfo { name?: string; owner_phone?: string | null; city?: string | null }

const SCHEMA_VERSION = 1;
const RESERVED = new Set(['public', 'information_schema', 'pg_catalog', 'pg_toast', 'shop']);
const VALID = /^[a-z_][a-z0-9_]{0,62}$/;

/** Shop id -> schema name: lower case, [a-z0-9_] only, never a system schema. "Gupta Kirana" -> "gupta_kirana". */
function schemaName(shopId: unknown): string {
  let s = String(shopId == null ? '' : shopId).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s || /^[0-9]/.test(s) || /^pg_/.test(s) || RESERVED.has(s)) s = 'shop_' + s;
  s = s.slice(0, 63).replace(/_+$/, '');
  if (!VALID.test(s)) throw new Error('cannot make a schema name from shop id ' + JSON.stringify(String(shopId)));
  return s;
}
const ident = (s: string) => { if (!VALID.test(s)) throw new Error('bad schema name ' + s); return '"' + s + '"'; };

// Registry columns on top of the shops table that migration 001 creates (pg-tables keeps working on the same database).
const REGISTRY_SQL = `
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS schema_name text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS schema_version integer;
CREATE UNIQUE INDEX IF NOT EXISTS shops_schema_name_uq ON public.shops (schema_name);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_schema_name_ok') THEN
    ALTER TABLE public.shops ADD CONSTRAINT shops_schema_name_ok CHECK (schema_name IS NULL OR schema_name ~ '^[a-z_][a-z0-9_]{0,62}$');
  END IF;
END $$;`;

/** The tables of one shop's schema. Run with search_path set to that schema only. */
const SHOP_DDL = `
CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY, pos integer NOT NULL, name text NOT NULL, name_key text, phone text, vpas jsonb,
  due_date date, last_reminder date, reminder_level integer, removed_on date, guest boolean, vouched_by text, vouch jsonb,
  created_on date, extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone);
CREATE INDEX IF NOT EXISTS customers_name_key_idx ON customers (name_key);
CREATE TABLE IF NOT EXISTS customer_txns (
  id text PRIMARY KEY, pos integer NOT NULL, customer_id text REFERENCES customers(id), type text NOT NULL, amount numeric NOT NULL,
  items jsonb, txn_date date, due_date date, note text, source text, voided boolean NOT NULL DEFAULT false,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS customer_txns_customer_idx ON customer_txns (customer_id, txn_date);
CREATE TABLE IF NOT EXISTS traders (
  id text PRIMARY KEY, pos integer, kind text NOT NULL CHECK (kind IN ('wholesaler', 'supplier')), name text NOT NULL,
  name_key text, phone text, extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS trader_txns (
  id text PRIMARY KEY, pos integer NOT NULL, trader_id text REFERENCES traders(id), type text NOT NULL CHECK (type IN ('supply', 'payment')),
  amount numeric NOT NULL, paid numeric, items jsonb, txn_date date, due_date date,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS trader_txns_trader_idx ON trader_txns (trader_id, txn_date);
CREATE TABLE IF NOT EXISTS items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, display_name text, units text,
  customer_rate numeric CHECK (customer_rate IS NULL OR customer_rate >= 0), customer_rate_updated_at date,
  trader_rate numeric CHECK (trader_rate IS NULL OR trader_rate >= 0), trader_unit text, trader_rate_updated_at date,
  in_price_book boolean NOT NULL DEFAULT false, price_pos integer, source text, extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS items_name_uq ON items (lower(name));
CREATE TABLE IF NOT EXISTS messages (
  pos integer PRIMARY KEY, msg_id text, to_party text, from_party text, body text, msg_date date, extra jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS orders (
  pos integer PRIMARY KEY, order_id text, customer_id text, status text, order_date date, extra jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS extras (
  key text PRIMARY KEY, value jsonb, updated_at timestamptz NOT NULL DEFAULT now());`;

// pg-tables table name -> table in the shop schema
const TABLE: Record<string, string> = { customers: 'customers', customer_txns: 'customer_txns', traders: 'traders', trader_txns: 'trader_txns', messages: 'messages', orders: 'orders', shop_extras: 'extras' };
const ORDER = Object.keys(TABLE);
const SHOP_TABLES = ['customers', 'customer_txns', 'traders', 'trader_txns', 'items', 'messages', 'orders', 'extras'];

const scopeTo = (client: Queryable, shopId: string) => client.query("SELECT set_config('app.shop_id', $1, true)", [shopId]); // RLS on public.shops
const useSchema = (client: Queryable, schema: string) => client.query("SELECT set_config('search_path', $1, true)", [ident(schema)]);

/** Inside the caller's transaction: registry columns, the shop's registry row and its schema (created once). Returns the schema name. */
async function ensureShop(client: Queryable, shopId: string, info?: ShopInfo | null): Promise<string> {
  const schema = schemaName(shopId);
  info = info || {};
  await client.query('SELECT pg_advisory_xact_lock(727002)');
  await client.query(REGISTRY_SQL);
  await scopeTo(client, shopId);
  const r = await client.query('SELECT schema_name, schema_version FROM public.shops WHERE id = $1', [shopId]);
  if (r.rows.length && r.rows[0].schema_name && r.rows[0].schema_name !== schema) throw new Error('shop ' + shopId + ' is registered with schema ' + r.rows[0].schema_name);
  if (r.rows.length && r.rows[0].schema_name === schema && r.rows[0].schema_version >= SCHEMA_VERSION) return schema;
  // the name must not belong to another shop (RLS hides other rows, so ask the catalog: a schema that exists but is not ours)
  const other = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (other.rows.length && !r.rows.length) {
    const owned = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'extras'", [schema]);
    if (!owned.rows.length) throw new Error('schema ' + schema + ' already exists and is not a shop schema');
  }
  await client.query('CREATE SCHEMA IF NOT EXISTS ' + ident(schema));
  await useSchema(client, schema);
  await client.query(SHOP_DDL);
  await client.query(`INSERT INTO public.shops (id, name, owner_phone, city, schema_name, schema_version) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET schema_name = EXCLUDED.schema_name, schema_version = EXCLUDED.schema_version, updated_at = now()`,
  [shopId, info.name || shopId, info.owner_phone || null, info.city || null, schema, SCHEMA_VERSION]);
  return schema;
}

async function insertRows(client: Queryable, table: string, rows: Row[]) {
  if (!rows.length) return;
  const cols = T.COLS[table];
  const names = cols.map((c) => c[0]).join(', ');
  const def = cols.map((c) => c[0] + ' ' + c[1]).join(', ');
  await client.query('INSERT INTO ' + TABLE[table] + ' (' + names + ') SELECT ' + names + ' FROM jsonb_to_recordset($1::jsonb) AS x(' + def + ')',
    [JSON.stringify(rows.map((r) => { const o: Row = {}; for (const [c] of cols) o[c] = r[c] === undefined ? null : r[c]; return o; }))]);
}

const PRICE_UPSERT = `INSERT INTO items (name, display_name, units, customer_rate, customer_rate_updated_at, trader_rate, in_price_book, price_pos, source, extra)
  SELECT name, display_name, unit, customer_rate, customer_rate_updated_at, trader_rate, true, price_pos, 'customer', extra
  FROM jsonb_to_recordset($1::jsonb) AS x(name text, display_name text, unit text, customer_rate numeric, customer_rate_updated_at date, trader_rate numeric, price_pos integer, extra jsonb)
  ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name, display_name = EXCLUDED.display_name, units = EXCLUDED.units,
    trader_rate = COALESCE(EXCLUDED.trader_rate, items.trader_rate),
    customer_rate = EXCLUDED.customer_rate, customer_rate_updated_at = EXCLUDED.customer_rate_updated_at, in_price_book = true,
    price_pos = EXCLUDED.price_pos, extra = EXCLUDED.extra, updated_at = now()`;
const TRADER_UPSERT = `INSERT INTO items (name, display_name, trader_rate, trader_unit, trader_rate_updated_at, source)
  SELECT name, display_name, trader_rate, trader_unit, trader_rate_updated_at, 'trader'
  FROM jsonb_to_recordset($1::jsonb) AS x(name text, display_name text, trader_rate numeric, trader_unit text, trader_rate_updated_at date)
  ON CONFLICT (lower(name)) DO UPDATE SET trader_rate = EXCLUDED.trader_rate, trader_unit = EXCLUDED.trader_unit,
    trader_rate_updated_at = EXCLUDED.trader_rate_updated_at, updated_at = now()
  WHERE items.trader_rate_updated_at IS NULL OR EXCLUDED.trader_rate_updated_at >= items.trader_rate_updated_at`;

/** Writes one shop inside the caller's transaction; same change-only rules as tables.writeShop. Returns the new `last`. */
async function writeShop(client: Queryable, shopId: string, schema: string, state: Row, last?: Snapshot | null): Promise<Snapshot> {
  last = last || {};
  const next: Snapshot = {};
  const { shop, tables, prices, traderRates } = T.stateToRows(state);
  await scopeTo(client, shopId);
  const s = shop || { name: '', owner_name: null, owner_phone: null, upi_id: null, extra: {} };
  next.shops = JSON.stringify(s);
  if (next.shops !== last.shops) {
    await client.query(`UPDATE public.shops SET name = $2, owner_name = $3, owner_phone = $4, upi_id = $5, extra = $6::jsonb, updated_at = now() WHERE id = $1`,
      [shopId, s.name, s.owner_name, s.owner_phone, s.upi_id, JSON.stringify(s.extra)]);
  }
  await useSchema(client, schema);
  for (const t of ORDER) next[t] = JSON.stringify(tables[t]);
  const changed = ORDER.filter((t) => next[t] !== last[t]);
  if (changed.includes('customers') && !changed.includes('customer_txns')) changed.push('customer_txns');
  if (changed.includes('traders') && !changed.includes('trader_txns')) changed.push('trader_txns');
  for (const t of ORDER.slice().reverse()) if (changed.includes(t)) await client.query('DELETE FROM ' + TABLE[t]);
  for (const t of ORDER) if (changed.includes(t)) await insertRows(client, t, tables[t]);
  next.prices = JSON.stringify(prices);
  if (next.prices !== last.prices) {
    await client.query('UPDATE items SET in_price_book = false, price_pos = NULL, updated_at = now() WHERE in_price_book');
    if (prices && prices.length) await client.query(PRICE_UPSERT, [JSON.stringify(prices)]);
  }
  next.traderRates = JSON.stringify(traderRates);
  if (next.traderRates !== last.traderRates && traderRates.length) await client.query(TRADER_UPSERT, [next.traderRates]);
  return next;
}

/** Reads one shop inside the caller's transaction; null when its schema holds no khata yet. */
async function readShop(client: Queryable, shopId: string, schema: string): Promise<Row | null> {
  await scopeTo(client, shopId);
  const s = await client.query('SELECT * FROM public.shops WHERE id = $1', [shopId]);
  if (!s.rows.length) return null;
  await useSchema(client, schema);
  const tables: Record<string, Row[]> = {};
  for (const t of ORDER) tables[t] = (await client.query('SELECT * FROM ' + TABLE[t])).rows;
  if (!tables.shop_extras.some((r) => r.key === '__keys')) return null;
  const items = (await client.query('SELECT *, units AS unit FROM items')).rows;
  return T.rowsToState(s.rows[0], tables, items);
}

/** Row counts of the shop schema's tables (caller's transaction). */
async function counts(client: Queryable, schema: string): Promise<Record<string, number>> {
  await useSchema(client, schema);
  const out: Record<string, number> = {};
  for (const t of SHOP_TABLES) out[t] = +(await client.query('SELECT count(*) FROM ' + t)).rows[0].count;
  return out;
}

/** Learns one item rate ('customer' selling or 'trader' buying) without touching the other side. */
async function learnItemRate(client: Queryable, schema: string, r: LearnRate): Promise<Row> {
  if (r.side !== 'customer' && r.side !== 'trader') throw new Error('side must be customer or trader');
  if (!(r.rate >= 0)) throw new Error('rate must be a number >= 0');
  const name = T.itemKey(r.name), at = r.at || new Date().toISOString().slice(0, 10);
  await useSchema(client, schema);
  const sql = r.side === 'customer'
    ? `INSERT INTO items (name, display_name, units, customer_rate, customer_rate_updated_at, source) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(name)) DO UPDATE SET customer_rate = EXCLUDED.customer_rate, units = COALESCE(EXCLUDED.units, items.units),
         customer_rate_updated_at = EXCLUDED.customer_rate_updated_at, updated_at = now() RETURNING *`
    : `INSERT INTO items (name, display_name, trader_unit, trader_rate, trader_rate_updated_at, source) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(name)) DO UPDATE SET trader_rate = EXCLUDED.trader_rate, trader_unit = COALESCE(EXCLUDED.trader_unit, items.trader_unit),
         trader_rate_updated_at = EXCLUDED.trader_rate_updated_at, updated_at = now() RETURNING *`;
  return (await client.query(sql, [name, String(r.name), r.unit || null, r.rate, at, r.source || r.side])).rows[0];
}

export { schemaName, ensureShop, writeShop, readShop, counts, learnItemRate, SHOP_TABLES, SCHEMA_VERSION };
