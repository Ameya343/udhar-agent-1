#!/usr/bin/env node
// Puts demo shops into the database, each in its own schema with its own tables (the STORE=pg-schema layout).
//   DATABASE_URL=... node dist-server/scripts/seed-shops.js zafar saikrupa [--apply] [--force]
// Dry run by default: prints what it would create, writes nothing.
// --apply runs the migrations, then for each shop in one transaction: registers it in public.shops, creates its schema
// and tables, writes the seeded khata (customers, entries, suppliers, rates) and reads it back to check nothing was lost,
// else it rolls back. A shop whose schema already holds a khata is not overwritten without --force.
import C = require('../core/agent-core');
import S = require('../server/schema');
import { pgTypes } from '../server/store';
import { migrate } from './migrate';
import type { Queryable, Row } from '../server/tables';

type Pg = typeof import('pg');
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o: Row = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Row)[k]); return o; }
  return v;
}
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

async function run(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void, opts?: { pg?: Pg; today?: string } | null): Promise<number> {
  opts = opts || {};
  const ids = argv.filter((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply'), force = argv.includes('--force');
  if (!ids.length) { out('usage: seed-shops.js <shop_id> [<shop_id> ...] [--apply] [--force]   shops: ' + Object.keys(C.DEMO_SHOPS).join(', ')); return 2; }
  const unknown = ids.filter((id) => !C.DEMO_SHOPS[id]);
  if (unknown.length) { out('unknown shop ' + unknown.join(', ') + '; known: ' + Object.keys(C.DEMO_SHOPS).join(', ')); return 2; }
  if (!env.DATABASE_URL) { out('DATABASE_URL is not set'); return 2; }
  const today = opts.today || localToday();
  const pg: Pg = opts.pg || require('pg');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, types: pgTypes(pg) });
  pool.on('error', () => {});
  const tx = async <R>(fn: (c: Queryable) => Promise<R>, commit: boolean): Promise<R> => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query(commit ? 'COMMIT' : 'ROLLBACK'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  };
  let failed = 0;
  try {
    if (apply) await migrate(pool);
    for (const id of ids) {
      const state = JSON.parse(JSON.stringify(C.freshShop(id, today)));
      const schema = S.schemaName(id);
      const what = state.shop.name + ' (' + id + ') -> schema ' + schema + ': ' + state.customers.length + ' customers, ' + state.txns.length + ' entries, ' + (state.wholesalers || []).length + ' suppliers';
      if (!apply) {
        const exists = await tx(async (c) => (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rows.length > 0, false);
        out(what + (exists ? ' (schema already exists)' : '') + '. Dry run, nothing written.');
        continue;
      }
      const res = await tx(async (c): Promise<{ refused?: boolean; n?: Record<string, number> }> => {
        await S.ensureShop(c, id, { name: state.shop.name, city: state.shop.city || null });
        const had = await S.readShop(c, id, schema);
        if (had && (had as Row).customers && ((had as Row).customers as unknown[]).length && !force) return { refused: true };
        await S.writeShop(c, id, schema, state, {});
        const back = await S.readShop(c, id, schema);
        if (!same(back, state)) throw new Error('khata read back from schema ' + schema + ' differs from what was written');
        return { n: await S.counts(c, schema) };
      }, true);
      if (res.refused) { out(what + ': schema already holds a khata; refusing to overwrite (use --force)'); failed++; continue; }
      out(what + ': written and verified (' + Object.entries(res.n!).map(([k, v]) => k + ' ' + v).join(', ') + ')');
    }
    if (!apply) out('Use --apply to write.');
    return failed ? 1 : 0;
  } finally { await pool.end(); }
}

export { run };
if (require.main === module) run(process.argv.slice(2), process.env, console.log).then((c) => process.exit(c), (e) => { console.error('failed: ' + (e as Error).message); process.exit(1); });
