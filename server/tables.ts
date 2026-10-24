// STORE=pg-tables: the in-memory khata (one state object per shop) <-> normalised tables (db/migrations).
// Each object field the app relies on gets a typed column; any other field, or a value that does not fit its
// column's type, goes to the row's "extra" jsonb, and fields that were absent are listed in extra._absent, so a
// load returns exactly the object that was saved. Array order is kept in "pos". Field order inside an object is
// not kept (JSON equality does not depend on it).
import { tokenize } from '../core/agent-core';

// This module maps any saved khata object, including old or hand-edited ones whose fields do not match core/types,
// so objects and rows are open records here: `any` values are checked at run time (FITS, isObj) before use.
export type Row = Record<string, any>;
/** The part of a pg client / pool this code uses. */
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> }
type ColType = 'text' | 'num' | 'int' | 'date' | 'bool' | 'json';
/** [field, column, type, notNullDefault?] */
type SpecEntry = [string, string, ColType, unknown?];
export interface LearnRate { side: string; name: string; rate: number; unit?: string | null; at?: string; source?: string }
export type Snapshot = Record<string, string>;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown) => typeof v === 'string' && DATE_RX.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const FITS: Record<ColType, (v: any) => boolean> = {
  text: (v) => typeof v === 'string' && !v.includes('\u0000'),
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  int: (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 31,
  date: validDate,
  bool: (v) => typeof v === 'boolean',
  json: () => true
};
const SQLTYPE = { text: 'text', num: 'numeric', int: 'integer', date: 'date', bool: 'boolean', json: 'jsonb' };

// spec: [[field, column, type, notNullDefault?], ...]
function split(obj: Row, spec: SpecEntry[]): Row {
  const row: Row = {}, extra: Row = {}, absent: string[] = [];
  const mapped = new Set(spec.map((s) => s[0]));
  for (const [field, col, type, dflt] of spec) {
    if (!has(obj, field)) { absent.push(field); row[col] = dflt !== undefined ? (typeof dflt === 'function' ? dflt() : dflt) : null; continue; }
    const v = obj[field];
    if (v === null && dflt === undefined) { row[col] = null; continue; }
    if (v !== null && FITS[type](v)) { row[col] = v; continue; }
    extra[field] = v; // keeps the exact value; the column gets a placeholder
    row[col] = dflt !== undefined ? (typeof dflt === 'function' ? dflt() : dflt) : null;
  }
  for (const k of Object.keys(obj)) if (!mapped.has(k)) extra[k] = obj[k];
  if (absent.length) extra._absent = absent;
  row.extra = extra;
  return row;
}
function join(row: Row, spec: SpecEntry[]): Row {
  const extra = row.extra || {}, absent = new Set(extra._absent || []), out: Row = {};
  for (const [field, col, type] of spec) {
    if (has(extra, field) || absent.has(field)) continue;
    let v = row[col];
    if (v != null && type === 'num') v = Number(v);
    out[field] = v === undefined ? null : v;
  }
  for (const k of Object.keys(extra)) if (k !== '_absent') out[k] = extra[k];
  return out;
}

const SPEC: Record<string, SpecEntry[]> = {
  shop: [['name', 'name', 'text', ''], ['owner', 'owner_name', 'text'], ['upiId', 'upi_id', 'text']],
  customer: [['id', 'id', 'text', ''], ['name', 'name', 'text', ''], ['key', 'name_key', 'text'], ['phone', 'phone', 'text'], ['vpas', 'vpas', 'json'],
    ['dueDate', 'due_date', 'date'], ['lastReminder', 'last_reminder', 'date'], ['reminderLevel', 'reminder_level', 'int'], ['removed', 'removed_on', 'date'],
    ['guest', 'guest', 'bool'], ['vouch', 'vouch', 'json'], ['createdAt', 'created_on', 'date']],
  txn: [['id', 'id', 'text', ''], ['custId', 'customer_id', 'text'], ['type', 'type', 'text', ''], ['amount', 'amount', 'num', 0], ['items', 'items', 'json'],
    ['date', 'txn_date', 'date'], ['dueDate', 'due_date', 'date'], ['note', 'note', 'text'], ['source', 'source', 'text'], ['voided', 'voided', 'bool', false]],
  wholesaler: [['id', 'id', 'text', ''], ['name', 'name', 'text', ''], ['key', 'name_key', 'text'], ['phone', 'phone', 'text']],
  supply: [['id', 'id', 'text', ''], ['amount', 'amount', 'num', 0], ['paid', 'paid', 'num'], ['lines', 'items', 'json'], ['date', 'txn_date', 'date'], ['dueDate', 'due_date', 'date']],
  payment: [['amount', 'amount', 'num', 0], ['date', 'txn_date', 'date']],
  price: [['name', 'display_name', 'text'], ['rate', 'customer_rate', 'num'], ['unit', 'unit', 'text'], ['date', 'customer_rate_updated_at', 'date'],
    ['traderRate', 'trader_rate', 'num']],
  message: [['id', 'msg_id', 'text'], ['to', 'to_party', 'text'], ['from', 'from_party', 'text'], ['text', 'body', 'text'], ['date', 'msg_date', 'date']],
  order: [['id', 'order_id', 'text'], ['custId', 'customer_id', 'text'], ['status', 'status', 'text'], ['date', 'order_date', 'date']]
};

// Table column lists for the bulk insert (jsonb_to_recordset). shop_id is added by the writer.
const COLS: Record<string, [string, string][]> = {
  customers: [['id', 'text'], ['pos', 'integer'], ['name', 'text'], ['name_key', 'text'], ['phone', 'text'], ['vpas', 'jsonb'], ['due_date', 'date'], ['last_reminder', 'date'],
    ['reminder_level', 'integer'], ['removed_on', 'date'], ['guest', 'boolean'], ['vouched_by', 'text'], ['vouch', 'jsonb'], ['created_on', 'date'], ['extra', 'jsonb']],
  customer_txns: [['id', 'text'], ['pos', 'integer'], ['customer_id', 'text'], ['type', 'text'], ['amount', 'numeric'], ['items', 'jsonb'], ['txn_date', 'date'], ['due_date', 'date'],
    ['note', 'text'], ['source', 'text'], ['voided', 'boolean'], ['extra', 'jsonb']],
  traders: [['id', 'text'], ['pos', 'integer'], ['kind', 'text'], ['name', 'text'], ['name_key', 'text'], ['phone', 'text'], ['extra', 'jsonb']],
  trader_txns: [['id', 'text'], ['pos', 'integer'], ['trader_id', 'text'], ['type', 'text'], ['amount', 'numeric'], ['paid', 'numeric'], ['items', 'jsonb'], ['txn_date', 'date'], ['due_date', 'date'], ['extra', 'jsonb']],
  messages: [['pos', 'integer'], ['msg_id', 'text'], ['to_party', 'text'], ['from_party', 'text'], ['body', 'text'], ['msg_date', 'date'], ['extra', 'jsonb']],
  orders: [['pos', 'integer'], ['order_id', 'text'], ['customer_id', 'text'], ['status', 'text'], ['order_date', 'date'], ['extra', 'jsonb']],
  shop_extras: [['key', 'text'], ['value', 'jsonb']]
};
// Parents before children (insert order); deletes run in reverse.
const ORDER = ['customers', 'customer_txns', 'traders', 'trader_txns', 'messages', 'orders', 'shop_extras'];

const itemKey = (name: unknown) => { const n = tokenize(String(name)).norm.join(' '); return n || String(name).toLowerCase().trim(); };

/** The state object -> { shop, tables: {name: rows[]}, prices: rows[]|null, traderRates: rows[] }. Pure. */
function stateToRows(state: Row): { shop: Row | null; tables: Record<string, Row[]>; prices: Row[] | null; traderRates: Row[] } {
  const tables: Record<string, Row[]> = {}; for (const t of ORDER) tables[t] = [];
  const extras = tables.shop_extras;
  const keys = Object.keys(state);
  extras.push({ key: '__keys', value: keys });
  const arr = (k: string) => Array.isArray(state[k]) && state[k].every(isObj);

  const shop = isObj(state.shop) ? split(state.shop, SPEC.shop) : null;
  if (shop) shop.owner_phone = typeof state.ownerPhone === 'string' ? state.ownerPhone : null;
  const handled = new Set<string>();
  if (shop) handled.add('shop');
  if (shop && shop.owner_phone !== null) handled.add('ownerPhone');

  const custIds = new Set();
  if (arr('customers') && new Set(state.customers.map((c: Row) => c.id)).size === state.customers.length && state.customers.every((c: Row) => FITS.text(c.id))) {
    handled.add('customers');
    state.customers.forEach((c: Row, pos: number) => {
      const r = split(c, SPEC.customer); r.pos = pos; r.vouched_by = isObj(c.vouch) && typeof c.vouch.by === 'string' ? c.vouch.by : null;
      tables.customers.push(r); custIds.add(c.id);
    });
  }
  if (arr('txns') && handled.has('customers') && new Set(state.txns.map((t: Row) => t.id)).size === state.txns.length && state.txns.every((t: Row) => FITS.text(t.id))) {
    handled.add('txns');
    state.txns.forEach((t: Row, pos: number) => {
      const r = split(t, SPEC.txn); r.pos = pos;
      if (r.customer_id !== null && !custIds.has(r.customer_id)) { r.extra.custId = t.custId; r.customer_id = null; } // customer no longer in the list
      tables.customer_txns.push(r);
    });
  }

  // traders: the wholesaler list, plus suppliers known only by name from the supplier khata
  const traderByKey = new Map<string, string>();
  if (arr('wholesalers') && new Set(state.wholesalers.map((w: Row) => w.id)).size === state.wholesalers.length && state.wholesalers.every((w: Row) => FITS.text(w.id) && !w.id.startsWith('sup:'))) {
    handled.add('wholesalers');
    state.wholesalers.forEach((w: Row, pos: number) => {
      const r = split(w, SPEC.wholesaler); r.pos = pos; r.kind = 'wholesaler'; tables.traders.push(r);
      if (typeof w.key === 'string' && !traderByKey.has(w.key)) traderByKey.set(w.key, w.id);
    });
  }
  const traderFor = (e: Row) => {
    if (typeof e.key !== 'string') return null;
    if (!traderByKey.has(e.key)) {
      const id = 'sup:' + e.key;
      traderByKey.set(e.key, id);
      tables.traders.push({ id, pos: null, kind: 'supplier', name: typeof e.name === 'string' && e.name ? e.name : e.key, name_key: e.key, phone: null, extra: {} });
    }
    return traderByKey.get(e.key);
  };
  const ids = new Set();
  if (arr('supplies') && state.supplies.every((k: Row) => FITS.text(k.id) && !k.id.startsWith('pay:')) && new Set(state.supplies.map((k: Row) => k.id)).size === state.supplies.length) {
    handled.add('supplies');
    state.supplies.forEach((k: Row, pos: number) => { const r = split(k, SPEC.supply); r.pos = pos; r.type = 'supply'; r.trader_id = traderFor(k); tables.trader_txns.push(r); ids.add(k.id); });
  }
  if (arr('supplierPays')) {
    handled.add('supplierPays');
    state.supplierPays.forEach((p: Row, pos: number) => {
      const r = split(p, SPEC.payment); r.pos = pos; r.type = 'payment'; r.id = 'pay:' + pos; r.paid = null; r.items = null; r.due_date = null; r.trader_id = traderFor(p);
      tables.trader_txns.push(r);
    });
  }
  if (arr('messages')) { handled.add('messages'); state.messages.forEach((m: Row, pos: number) => { const r = split(m, SPEC.message); r.pos = pos; tables.messages.push(r); }); }
  if (arr('orders')) { handled.add('orders'); state.orders.forEach((o: Row, pos: number) => { const r = split(o, SPEC.order); r.pos = pos; tables.orders.push(r); }); }

  // items: the customer rate book (state.prices) and buying rates learned from supplier bills
  let prices: Row[] | null = null;
  if (isObj(state.prices)) {
    const pk = Object.keys(state.prices);
    if (pk.every((k) => isObj(state.prices[k]) && k.length > 0) && new Set(pk.map((k) => k.toLowerCase())).size === pk.length) {
      handled.add('prices');
      prices = pk.map((k, pos) => { const r = split(state.prices[k], SPEC.price); r.name = k; r.price_pos = pos; return r; });
    }
  }
  const traderRates = new Map<string, Row>();
  if (Array.isArray(state.supplies)) for (const k of state.supplies) {
    if (!isObj(k) || !Array.isArray(k.lines) || !validDate(k.date)) continue;
    for (const l of k.lines) {
      if (!isObj(l) || typeof l.name !== 'string' || !l.name.trim() || !(l.qty > 0) || !(l.price > 0)) continue;
      const key = itemKey(l.name), prev = traderRates.get(key.toLowerCase());
      if (prev && prev.trader_rate_updated_at > k.date) continue;
      traderRates.set(key.toLowerCase(), { name: key, display_name: l.name, trader_rate: Math.round((l.price / l.qty) * 100) / 100, trader_unit: typeof l.unit === 'string' ? l.unit : null, trader_rate_updated_at: k.date });
    }
  }

  for (const k of keys) if (!handled.has(k)) extras.push({ key: k, value: state[k] });
  return { shop, tables, prices, traderRates: [...traderRates.values()] };
}

/** Rows read back (same shape as stateToRows gives) -> the state object. Pure. */
function rowsToState(shop: Row, tables: Record<string, Row[]>, items: Row[]): Row {
  const ex = new Map<string, any>(tables.shop_extras.map((r) => [r.key, r.value]));
  const keys: string[] = ex.get('__keys') || [];
  const byPos = (rows: Row[]) => rows.slice().sort((a, b) => a.pos - b.pos);
  const state: Row = {};
  for (const k of keys) {
    if (ex.has(k)) { state[k] = ex.get(k); continue; }
    switch (k) {
      case 'shop': state.shop = join(shop, SPEC.shop); break;
      case 'ownerPhone': state.ownerPhone = shop.owner_phone; break;
      case 'customers': state.customers = byPos(tables.customers).map((r) => join(r, SPEC.customer)); break;
      case 'txns': state.txns = byPos(tables.customer_txns).map((r) => join(r, SPEC.txn)); break;
      case 'wholesalers': state.wholesalers = byPos(tables.traders.filter((r) => r.kind === 'wholesaler' && r.pos !== null)).map((r) => join(r, SPEC.wholesaler)); break;
      case 'supplies': state.supplies = byPos(tables.trader_txns.filter((r) => r.type === 'supply')).map((r) => join(r, SPEC.supply)); break;
      case 'supplierPays': state.supplierPays = byPos(tables.trader_txns.filter((r) => r.type === 'payment')).map((r) => join(r, SPEC.payment)); break;
      case 'messages': state.messages = byPos(tables.messages).map((r) => join(r, SPEC.message)); break;
      case 'orders': state.orders = byPos(tables.orders).map((r) => join(r, SPEC.order)); break;
      case 'prices': {
        state.prices = {};
        for (const r of items.filter((i) => i.in_price_book).sort((a, b) => a.price_pos - b.price_pos)) state.prices[r.name] = join(r, SPEC.price);
        break;
      }
      default: break; // unreachable: every other key is in shop_extras
    }
  }
  return state;
}

// ------------------------------------------------------------------ database side
const withShop = async (client: Queryable, shopId: string) => client.query("SELECT set_config('app.shop_id', $1, true)", [shopId]);

async function insertRows(client: Queryable, table: string, shopId: string, rows: Row[]) {
  if (!rows.length) return;
  const cols = COLS[table];
  const names = cols.map((c) => c[0]).join(', ');
  const def = cols.map((c) => c[0] + ' ' + c[1]).join(', ');
  await client.query('INSERT INTO ' + table + ' (shop_id, ' + names + ') SELECT $1, ' + names + ' FROM jsonb_to_recordset($2::jsonb) AS x(' + def + ')',
    [shopId, JSON.stringify(rows.map((r) => { const o: Row = {}; for (const [c] of cols) o[c] = r[c] === undefined ? null : r[c]; return o; }))]);
}

// trader_rate from the rate book (a price entry's optional traderRate) never clears a buying rate learned from a bill
const ITEM_PRICE_UPSERT = `INSERT INTO items (shop_id, name, display_name, unit, customer_rate, customer_rate_updated_at, trader_rate, in_price_book, price_pos, source, extra)
  SELECT $1, name, display_name, unit, customer_rate, customer_rate_updated_at, trader_rate, true, price_pos, 'customer', extra
  FROM jsonb_to_recordset($2::jsonb) AS x(name text, display_name text, unit text, customer_rate numeric, customer_rate_updated_at date, trader_rate numeric, price_pos integer, extra jsonb)
  ON CONFLICT (shop_id, lower(name)) DO UPDATE SET name = EXCLUDED.name, display_name = EXCLUDED.display_name, unit = EXCLUDED.unit,
    trader_rate = COALESCE(EXCLUDED.trader_rate, items.trader_rate),
    customer_rate = EXCLUDED.customer_rate, customer_rate_updated_at = EXCLUDED.customer_rate_updated_at, in_price_book = true,
    price_pos = EXCLUDED.price_pos, extra = EXCLUDED.extra, updated_at = now()`;
const ITEM_TRADER_UPSERT = `INSERT INTO items (shop_id, name, display_name, trader_rate, trader_unit, trader_rate_updated_at, source)
  SELECT $1, name, display_name, trader_rate, trader_unit, trader_rate_updated_at, 'trader'
  FROM jsonb_to_recordset($2::jsonb) AS x(name text, display_name text, trader_rate numeric, trader_unit text, trader_rate_updated_at date)
  ON CONFLICT (shop_id, lower(name)) DO UPDATE SET trader_rate = EXCLUDED.trader_rate, trader_unit = EXCLUDED.trader_unit,
    trader_rate_updated_at = EXCLUDED.trader_rate_updated_at, updated_at = now()
  WHERE items.trader_rate_updated_at IS NULL OR EXCLUDED.trader_rate_updated_at >= items.trader_rate_updated_at`;

/**
 * Writes one shop inside the caller's transaction. Each table whose rows changed since `last` is replaced for this
 * shop (delete + bulk insert); unchanged tables are not touched. Items are upserted, never deleted: an item dropped
 * from the rate book keeps its row with in_price_book = false, and buying rates are kept.
 * Returns the new `last` snapshot (serialised rows per table).
 */
async function writeShop(client: Queryable, shopId: string, state: Row, last?: Snapshot | null): Promise<Snapshot> {
  last = last || {};
  const next: Snapshot = {};
  const { shop, tables, prices, traderRates } = stateToRows(state);
  await withShop(client, shopId);
  const s = shop || { name: '', owner_name: null, owner_phone: null, upi_id: null, extra: {} };
  next.shops = JSON.stringify(s);
  if (next.shops !== last.shops) {
    await client.query(`INSERT INTO shops (id, name, owner_name, owner_phone, upi_id, extra) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_name = EXCLUDED.owner_name, owner_phone = EXCLUDED.owner_phone, upi_id = EXCLUDED.upi_id, extra = EXCLUDED.extra, updated_at = now()`,
    [shopId, s.name, s.owner_name, s.owner_phone, s.upi_id, JSON.stringify(s.extra)]);
  }
  for (const t of ORDER) next[t] = JSON.stringify(tables[t]);
  const changed = ORDER.filter((t) => next[t] !== last[t]);
  // a parent table that is replaced takes its children with it (their FKs point at it)
  if (changed.includes('customers') && !changed.includes('customer_txns')) changed.push('customer_txns');
  if (changed.includes('traders') && !changed.includes('trader_txns')) changed.push('trader_txns');
  for (const t of ORDER.slice().reverse()) if (changed.includes(t)) await client.query('DELETE FROM ' + t + ' WHERE shop_id = $1', [shopId]);
  for (const t of ORDER) if (changed.includes(t)) await insertRows(client, t, shopId, tables[t]);

  next.prices = JSON.stringify(prices);
  if (next.prices !== last.prices) {
    await client.query('UPDATE items SET in_price_book = false, price_pos = NULL, updated_at = now() WHERE shop_id = $1 AND in_price_book', [shopId]);
    if (prices && prices.length) await client.query(ITEM_PRICE_UPSERT, [shopId, JSON.stringify(prices)]);
  }
  next.traderRates = JSON.stringify(traderRates);
  if (next.traderRates !== last.traderRates && traderRates.length) await client.query(ITEM_TRADER_UPSERT, [shopId, next.traderRates]);
  return next;
}

/** Reads one shop inside the caller's transaction. Returns null when the shop has no row. */
async function readShop(client: Queryable, shopId: string): Promise<Row | null> {
  await withShop(client, shopId);
  const s = await client.query('SELECT * FROM shops WHERE id = $1', [shopId]);
  if (!s.rows.length) return null;
  const tables: Record<string, Row[]> = {};
  for (const t of ORDER) tables[t] = (await client.query('SELECT * FROM ' + t + ' WHERE shop_id = $1', [shopId])).rows;
  const items = (await client.query('SELECT * FROM items WHERE shop_id = $1', [shopId])).rows;
  return rowsToState(s.rows[0], tables, items);
}

/**
 * Learns one rate for an item from a conversation: side 'customer' (selling) or 'trader' (buying). Upserts on
 * (shop_id, lower(name)) and touches only that side's columns, so the other rate is never overwritten.
 */
async function learnItemRate(client: Queryable, shopId: string, r: LearnRate): Promise<Row> {
  if (r.side !== 'customer' && r.side !== 'trader') throw new Error('side must be customer or trader');
  if (!(r.rate >= 0)) throw new Error('rate must be a number >= 0');
  const name = itemKey(r.name), at = r.at || new Date().toISOString().slice(0, 10);
  await withShop(client, shopId);
  const sql = r.side === 'customer'
    ? `INSERT INTO items (shop_id, name, display_name, unit, customer_rate, customer_rate_updated_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop_id, lower(name)) DO UPDATE SET customer_rate = EXCLUDED.customer_rate, unit = COALESCE(EXCLUDED.unit, items.unit),
         customer_rate_updated_at = EXCLUDED.customer_rate_updated_at, updated_at = now() RETURNING *`
    : `INSERT INTO items (shop_id, name, display_name, trader_unit, trader_rate, trader_rate_updated_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shop_id, lower(name)) DO UPDATE SET trader_rate = EXCLUDED.trader_rate, trader_unit = COALESCE(EXCLUDED.trader_unit, items.trader_unit),
         trader_rate_updated_at = EXCLUDED.trader_rate_updated_at, updated_at = now() RETURNING *`;
  return (await client.query(sql, [shopId, name, String(r.name), r.unit || null, r.rate, at, r.source || r.side])).rows[0];
}

export { stateToRows, rowsToState, writeShop, readShop, learnItemRate, split, join, itemKey, SPEC, COLS };
