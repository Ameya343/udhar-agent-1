#!/usr/bin/env node
// Copies one shop from the shared pg-tables tables (rows keyed by shop_id) into that shop's own schema (STORE=pg-schema).
//   DATABASE_URL=... node dist-server/scripts/pg-tables-to-schema.js <shop_id> [--apply] [--force]
// Dry run by default: reads the shop, prints the row counts it would copy, writes nothing.
// --apply creates the schema (if needed), copies everything in one transaction and verifies: the row counts match the
// old tables and the khata read back from the schema equals the one read from the old tables, else it rolls back.
// The old tables are only read, never changed. A schema that already holds a khata is not overwritten without --force.
import T = require('../server/tables');
import S = require('../server/schema');
import { pgTypes } from '../server/store';
import { migrate } from './migrate';
import type { Queryable, Row } from '../server/tables';

type Pg = typeof import('pg');
const OLD: Record<string, string> = { customers: 'customers', customer_txns: 'customer_txns', traders: 'traders', trader_txns: 'trader_txns', items: 'items', messages: 'messages', orders: 'orders', extras: 'shop_extras' };
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o: Row = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Row)[k]); return o; }
  return v;
}

async function oldCounts(c: Queryable, shopId: string): Promise<Record<string, number>> {
  await c.query("SELECT set_config('app.shop_id', $1, true)", [shopId]);
  await c.query("SELECT set_config('search_path', 'public', true)");
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(OLD)) out[k] = +(await c.query('SELECT count(*) FROM ' + t + ' WHERE shop_id = $1', [shopId])).rows[0].count;
  return out;
}

async function run(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void, opts?: { pg?: Pg } | null): Promise<number> {
  opts = opts || {};
  const args = argv.filter((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply'), force = argv.includes('--force');
  const [shopId] = args;
  if (!shopId) { out('usage: pg-tables-to-schema.js <shop_id> [--apply] [--force]'); return 2; }
  if (!env.DATABASE_URL) { out('DATABASE_URL is not set'); return 2; }
  const schema = S.schemaName(shopId);
  const pg: Pg = opts.pg || require('pg');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, types: pgTypes(pg) });
  pool.on('error', () => {});
  const tx = async <R>(fn: (c: Queryable) => Promise<R>, commit: boolean): Promise<R> => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query(commit ? 'COMMIT' : 'ROLLBACK'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  };
  try {
    await migrate(pool);
    const src = await tx(async (c) => ({ state: await T.readShop(c, shopId), n: await oldCounts(c, shopId) }), false);
    if (!src.state || !src.state.shop) { out('shop ' + shopId + ': no khata in the shared tables'); return 1; }
    out('shop ' + shopId + ' -> schema ' + schema + ': ' + Object.entries(src.n).map(([k, v]) => k + ' ' + v).join(', '));
    if (!apply) {
      const exists = await tx(async (c) => (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rows.length > 0, false);
      out('dry run, nothing written' + (exists ? ' (schema ' + schema + ' already exists)' : '') + '. Use --apply.');
      return 0;
    }
    const res = await tx(async (c): Promise<{ refused?: boolean; n?: Record<string, number> }> => {
      await S.ensureShop(c, shopId);
      const had = await S.readShop(c, shopId, schema);
      if (had && !force) return { refused: true };
      await S.writeShop(c, shopId, schema, src.state!, {});
      const n = await S.counts(c, schema);
      const bad = Object.keys(OLD).filter((k) => k !== 'items' && n[k] !== src.n[k]); // items checked below
      if (bad.length) throw new Error('count mismatch: ' + bad.map((k) => k + ' old ' + src.n[k] + ' new ' + n[k]).join(', '));
      // items: the copy must also keep every buying rate learned outside the rate book
      await c.query("SELECT set_config('search_path', 'public', true)");
      const oldItems = (await c.query('SELECT name, display_name, unit, customer_rate, trader_rate, trader_unit, trader_rate_updated_at FROM items WHERE shop_id = $1 ORDER BY lower(name)', [shopId])).rows;
      await c.query("SELECT set_config('search_path', $1, true)", ['"' + schema + '"']);
      const newItems = (await c.query('SELECT name, display_name, units AS unit, customer_rate, trader_rate, trader_unit, trader_rate_updated_at FROM items ORDER BY lower(name)')).rows;
      const norm = (rows: Row[]) => rows.map((r) => Object.assign({}, r, { customer_rate: r.customer_rate == null ? null : +r.customer_rate, trader_rate: r.trader_rate == null ? null : +r.trader_rate }));
      // items learned only by conversation are not in the khata object; copy them over
      const have = new Set(newItems.map((r) => r.name.toLowerCase()));
      for (const r of oldItems.filter((x) => !have.has(x.name.toLowerCase()))) {
        await c.query('INSERT INTO items (name, display_name, units, customer_rate, trader_rate, trader_unit, trader_rate_updated_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [r.name, r.display_name, r.unit, r.customer_rate, r.trader_rate, r.trader_unit, r.trader_rate_updated_at, 'migrated']);
      }
      const finalItems = (await c.query('SELECT name, display_name, units AS unit, customer_rate, trader_rate, trader_unit, trader_rate_updated_at FROM items ORDER BY lower(name)')).rows;
      if (!same(norm(oldItems), norm(finalItems))) throw new Error('items differ after copy');
      const back = await S.readShop(c, shopId, schema);
      if (!same(back, src.state)) throw new Error('khata read back from the schema differs from the shared tables');
      return { n: await S.counts(c, schema) };
    }, true);
    if (res.refused) { out('schema ' + schema + ' already holds a khata; refusing to overwrite (use --force)'); return 1; }
    out('copied and verified: ' + Object.entries(res.n!).map(([k, v]) => k + ' ' + v).join(', ') + '. Shared tables left unchanged.');
    return 0;
  } finally { await pool.end(); }
}

export { run };
if (require.main === module) run(process.argv.slice(2), process.env, console.log).then((c) => process.exit(c), (e) => { console.error('failed: ' + (e as Error).message); process.exit(1); });
