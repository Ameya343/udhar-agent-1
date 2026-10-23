#!/usr/bin/env node
'use strict';
// Imports a JSON khata (data/<shop>.json) into Postgres under a shop_id.
//   DATABASE_URL=... node scripts/import-json-to-pg.js <file.json> <shop_id> [--apply] [--force]
// Dry run by default: validates the file and says what would happen. --apply writes it.
// An existing row for the shop is never overwritten unless --force is given.
const fs = require('fs');
const { createPgStore, UPSERT } = require('../server/store.js');

async function run(argv, env, out) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply'), force = argv.includes('--force');
  const [file, shopId] = args;
  if (!file || !shopId) { out('usage: import-json-to-pg.js <file.json> <shop_id> [--apply] [--force]'); return 2; }
  if (!env.DATABASE_URL) { out('DATABASE_URL is not set'); return 2; }
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out('cannot read ' + file + ': ' + e.message); return 1; }
  if (!state || !state.shop) { out(file + ' is not a khata (no "shop")'); return 1; }
  const txns = Array.isArray(state.txns) ? state.txns.length : 0, customers = Array.isArray(state.customers) ? state.customers.length : 0;
  const store = await createPgStore(env.DATABASE_URL, shopId);
  try {
    const existing = store.load();
    out('shop_id ' + shopId + ': ' + customers + ' customers, ' + txns + ' txns' + (existing ? ' (a row already exists)' : ''));
    if (existing && !force) { out(apply ? 'refusing to overwrite; use --force' : 'would refuse to overwrite; --force needed'); return apply ? 1 : 0; }
    if (!apply) { out('dry run, nothing written. Use --apply.'); return 0; }
    store.save(state);
    await store.flush();
    if (store.lastError) { out('write failed: ' + store.lastError); return 1; }
    out('imported.');
    return 0;
  } finally { await store.close(); }
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2), process.env, console.log).then((c) => process.exit(c), (e) => { console.error('failed: ' + e.message); process.exit(1); });
