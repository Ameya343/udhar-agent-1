'use strict';
// STORE=pg-schema, the pg-tables -> schema copy and the demo filler. The database tests need their OWN scratch
// database (they drop schemas and the shared tables, so they must not share one with pgtables.test.js, which runs in
// parallel): TEST_SCHEMA_DATABASE_URL=postgres://khata:pw@localhost/khata_schema_test. Skipped when unset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const S = require('../dist-server/server/schema.js');
const { createPgSchemaStore, createPgTablesStore, openStore, pgTypes } = require('../dist-server/server/store.js');
const mig = require('../dist-server/scripts/pg-tables-to-schema.js');
const fill = require('../dist-server/scripts/fill-demo.js');

const URL = process.env.TEST_SCHEMA_DATABASE_URL;
const skip = URL ? false : 'TEST_SCHEMA_DATABASE_URL not set';
const TODAY = '2025-01-15';
const plain = (x) => JSON.parse(JSON.stringify(x));

function pool() { const pg = require('pg'); return new pg.Pool({ connectionString: URL, types: pgTypes(pg) }); }
async function reset() {
  const p = pool();
  const r = await p.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('public', 'information_schema')");
  for (const { nspname } of r.rows) await p.query('DROP SCHEMA "' + nspname + '" CASCADE');
  await p.query('DROP TABLE IF EXISTS customer_txns, customers, trader_txns, traders, items, messages, orders, shop_extras, shops, schema_migrations CASCADE');
  await p.end();
}

function usedKhata(id) {
  const s = C.freshShop(id || 'gupta', TODAY);
  const say = (t) => C.runAction(s, 'owner', { text: t, source: 'text' });
  say('Sharma ji ne 340 ka saaman liya, Friday ko denge');
  say('Iqbal bhai ne 200 diye');
  say('Naya grahak Pappu ne 2 kg cheeni 90 aur 1 kg atta 44 liya');
  say('Agrawal traders se 10 kg cheeni 400, 5 kg dal 600 udhaar, 20 tareekh tak');
  say('Gopal dairy se 20 litre doodh 1000 udhaar');
  say('Agrawal traders ko 500 diye');
  s.txns[1].voided = true;
  s.customers[2].removed = TODAY;
  s.customers[4].removed = true;
  s.txns[3].custId = 'C999';
  s.customers[6].dueDate = 'kal';
  s.orders = [{ id: 'O001', custId: 'C001', status: 'new', date: TODAY }];
  s.ownerPhone = '9822000000';
  s.custom = { anything: [1, 'two', null] };
  return plain(s);
}

test('schema names are sanitised from the shop id', () => {
  assert.strictEqual(S.schemaName('gupta'), 'gupta');
  assert.strictEqual(S.schemaName('Gupta Kirana-2'), 'gupta_kirana_2');
  assert.strictEqual(S.schemaName('123'), 'shop_123');
  assert.strictEqual(S.schemaName('public'), 'shop_public');
  assert.strictEqual(S.schemaName('pg_catalog'), 'shop_pg_catalog');
  assert.strictEqual(S.schemaName('"; DROP TABLE x; --'), 'drop_table_x');
  assert.ok(S.schemaName('x'.repeat(100)).length <= 63);
  for (const odd of ['!!!', 'é', '', null]) assert.match(S.schemaName(odd), /^shop_[a-z0-9_]*$|^shop$/);
});

test('schema store: creates the shop schema on first start, tables without shop_id', { skip }, async () => {
  await reset();
  const st = await createPgSchemaStore(URL, 'gupta');
  assert.strictEqual(st.load(), null);
  assert.strictEqual(st.schema, 'gupta');
  await st.close();
  const p = pool();
  const t = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'gupta' ORDER BY 1");
  assert.deepStrictEqual(t.rows.map((r) => r.table_name), ['customer_txns', 'customers', 'extras', 'items', 'messages', 'orders', 'trader_txns', 'traders']);
  const sid = await p.query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'gupta' AND column_name = 'shop_id'");
  assert.strictEqual(+sid.rows[0].count, 0);
  const cols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'gupta' AND table_name = 'items'");
  for (const c of ['customer_rate', 'trader_rate', 'units', 'updated_at']) assert.ok(cols.rows.some((r) => r.column_name === c), 'items.' + c);
  const fk = await p.query("SELECT count(*) FROM information_schema.table_constraints WHERE table_schema = 'gupta' AND constraint_type = 'FOREIGN KEY'");
  assert.strictEqual(+fk.rows[0].count, 2);
  const reg = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shops'");
  for (const c of ['id', 'name', 'owner_phone', 'city', 'created_at', 'schema_name']) assert.ok(reg.rows.some((r) => r.column_name === c), 'shops.' + c);
  await p.end();
  // second start: idempotent
  const again = await createPgSchemaStore(URL, 'gupta'); assert.strictEqual(again.load(), null); await again.close();
});

test('schema store: round-trip loses nothing; second save writes only what changed', { skip }, async () => {
  await reset();
  const st = usedKhata('gupta');
  const a = await createPgSchemaStore(URL, 'gupta');
  a.save(st); await a.flush(); assert.strictEqual(a.lastError, null); await a.close();
  const b = await createPgSchemaStore(URL, 'gupta');
  assert.deepStrictEqual(b.load(), st);
  const n = await b.withShop((c) => S.counts(c, 'gupta'));
  assert.strictEqual(n.customers, st.customers.length);
  assert.strictEqual(n.customer_txns, st.txns.length);
  assert.strictEqual(n.trader_txns, st.supplies.length + st.supplierPays.length);
  const cheeni = await b.withShop((c) => c.query("SELECT * FROM items WHERE name = 'chini'"));
  assert.strictEqual(Number(cheeni.rows[0].trader_rate), 40);
  const before = await b.withShop((c) => c.query('SELECT created_at FROM trader_txns ORDER BY id LIMIT 1'));
  const s2 = b.load(); s2.messages.push({ id: 'Wx', to: 'owner', from: 'agent', text: 'hi', date: TODAY });
  b.save(s2); await b.flush(); assert.strictEqual(b.lastError, null);
  const after = await b.withShop((c) => c.query('SELECT created_at FROM trader_txns ORDER BY id LIMIT 1'));
  assert.deepStrictEqual(after.rows, before.rows);
  await b.close();
  const c3 = await createPgSchemaStore(URL, 'gupta'); assert.deepStrictEqual(c3.load(), plain(s2)); await c3.close();
});

test('two shops live in two schemas, isolated', { skip }, async () => {
  await reset();
  const a = await createPgSchemaStore(URL, 'gupta'), b = await createPgSchemaStore(URL, 'sharma');
  const sa = usedKhata('gupta'), sb = plain(C.freshShop('sharma', TODAY));
  sb.customers[0].name = 'Only in Sharma';
  a.save(sa); b.save(sb); await a.flush(); await b.flush();
  assert.strictEqual(a.lastError, null); assert.strictEqual(b.lastError, null);
  await a.close(); await b.close();
  const a2 = await createPgSchemaStore(URL, 'gupta'), b2 = await createPgSchemaStore(URL, 'sharma');
  assert.deepStrictEqual(a2.load(), sa); assert.deepStrictEqual(b2.load(), sb);
  // unqualified names in withShop resolve to the shop's own schema only
  const seen = await b2.withShop((c) => c.query('SELECT name FROM customers WHERE id = $1', ['C001']));
  assert.deepStrictEqual(seen.rows, [{ name: 'Only in Sharma' }]);
  const p = pool();
  const g = await p.query('SELECT name FROM gupta.customers WHERE id = $1', ['C001']);
  assert.strictEqual(g.rows[0].name, sa.customers[0].name);
  // a save to one shop does not touch the other
  sb.customers[0].name = 'Changed'; b2.save(sb); await b2.flush();
  assert.strictEqual((await p.query('SELECT name FROM gupta.customers WHERE id = $1', ['C001'])).rows[0].name, sa.customers[0].name);
  await p.end(); await a2.close(); await b2.close();
});

test('openStore with STORE=pg-schema: dual-writes JSON and loads an existing JSON khata into an empty schema', { skip }, async () => {
  await reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  const st = usedKhata('gupta');
  fs.writeFileSync(path.join(dir, 'gupta.json'), JSON.stringify(st));
  const env = { DATABASE_URL: URL, STORE: 'pg-schema', DUAL_WRITE_JSON: '1' };
  const s = await openStore(env, dir, 'gupta', { log: () => {} });
  assert.strictEqual(s.kind, 'pg-schema');
  assert.deepStrictEqual(s.load(), st);
  const s2 = plain(st); s2.custom = 'x'; s.save(s2); await s.flush(); await s.close();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'gupta.json'), 'utf8')), s2);
  const again = await createPgSchemaStore(URL, 'gupta'); assert.deepStrictEqual(again.load(), s2); await again.close();
  // database down at start: runs on the JSON file
  const down = await openStore({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none', STORE: 'pg-schema', DUAL_WRITE_JSON: '1' }, dir, 'gupta', { log: () => {}, delays: [], reconnectMs: 0 });
  assert.strictEqual(down.kind, 'file'); assert.deepStrictEqual(down.load(), s2); await down.close();
});

test('migration script copies a shop from pg-tables into its schema: dry run, apply, counts, old tables untouched', { skip }, async () => {
  await reset();
  const sa = usedKhata('gupta'), sb = plain(C.freshShop('sharma', TODAY));
  const ta = await createPgTablesStore(URL, 'gupta'), tb = await createPgTablesStore(URL, 'sharma');
  ta.save(sa); tb.save(sb); await ta.flush(); await tb.flush();
  // an item learned only in conversation (not in the khata object) must be carried over too
  await ta.withShop((c) => require('../dist-server/server/tables.js').learnItemRate(c, 'gupta', { name: 'saboodana', side: 'trader', rate: 70, unit: 'kg', at: TODAY }));
  await ta.close(); await tb.close();
  const env = { DATABASE_URL: URL }, lines = [], out = (l) => lines.push(l);
  assert.strictEqual(await mig.run(['gupta'], env, out), 0);
  assert.match(lines.join('\n'), /dry run/);
  const p = pool();
  assert.strictEqual((await p.query("SELECT 1 FROM pg_namespace WHERE nspname = 'gupta'")).rows.length, 0, 'dry run creates nothing');
  assert.strictEqual(await mig.run(['gupta', '--apply'], env, out), 0);
  assert.match(lines.join('\n'), /copied and verified/);
  const n = +(await p.query('SELECT count(*) FROM gupta.customers')).rows[0].count;
  assert.strictEqual(n, sa.customers.length);
  assert.strictEqual(+(await p.query('SELECT count(*) FROM gupta.customer_txns')).rows[0].count, sa.txns.length);
  assert.strictEqual(+(await p.query('SELECT count(*) FROM gupta.items WHERE name = $1', [require('../dist-server/server/tables.js').itemKey('saboodana')])).rows[0].count, 1);
  const s = await createPgSchemaStore(URL, 'gupta'); assert.deepStrictEqual(s.load(), sa); await s.close();
  // old tables still hold the shop, unchanged
  const old = await createPgTablesStore(URL, 'gupta'); assert.deepStrictEqual(old.load(), sa); await old.close();
  // no overwrite without --force; the other shop was not copied
  assert.strictEqual(await mig.run(['gupta', '--apply'], env, out), 1);
  assert.strictEqual(await mig.run(['gupta', '--apply', '--force'], env, out), 0);
  assert.strictEqual((await p.query("SELECT 1 FROM pg_namespace WHERE nspname = 'sharma'")).rows.length, 0);
  assert.strictEqual(await mig.run(['nobody', '--apply'], env, out), 1);
  assert.ok(!lines.join('\n').includes(URL));
  await p.end();
});

// ---------------------------------------------------------------- fill-demo (pure; plus one database run)
function mixedKhata() {
  const s = plain(C.freshShop('gupta', TODAY));
  s.customers.push({ id: 'C900', name: 'Real Ramesh', key: 'ramesh', phone: '9823012345', vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: TODAY });
  s.customers.push({ id: 'C901', name: '', key: '', phone: null, demo: true, vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: TODAY });
  s.customers.push({ id: 'C902', name: 'No phone', key: 'no phone', phone: null, vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: TODAY });
  s.customers.push({ id: 'C903', name: 'Marked but real', key: 'x', phone: '9850011122', demo: true, vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: TODAY });
  return s;
}

test('fill-demo: units and wholesale rates for every item, below the selling rate', () => {
  const s = mixedKhata();
  const changes = fill.fillDemo(s, { today: TODAY });
  assert.ok(changes.length > 0);
  for (const [k, p] of Object.entries(s.prices)) {
    assert.ok(p.unit, k + ' has a unit');
    assert.ok(p.traderRate > 0 && p.traderRate < p.rate, k + ' trader rate below customer rate');
  }
  assert.strictEqual(s.prices.magi.unit, 'pkt');
  assert.strictEqual(s.prices.biscuit.unit, 'pkt');
  assert.strictEqual(s.prices.chini.unit, 'kg');
});

test('fill-demo: demo customers get name, fake phone, due date and varied txns; real customers are never touched', () => {
  const s = mixedKhata();
  const realBefore = plain(s.customers.filter((c) => !fill.isDemoCustomer(c)));
  const realTxns = plain(s.txns.filter((t) => realBefore.some((c) => c.id === t.custId)));
  fill.fillDemo(s, { today: TODAY });
  assert.deepStrictEqual(plain(s.customers.filter((c) => realBefore.some((r) => r.id === c.id))), realBefore);
  assert.deepStrictEqual(plain(s.txns.filter((t) => realBefore.some((c) => c.id === t.custId))), realTxns);
  assert.ok(realBefore.some((c) => c.id === 'C900') && realBefore.some((c) => c.id === 'C902') && realBefore.some((c) => c.id === 'C903'));
  const demo = s.customers.filter(fill.isDemoCustomer);
  assert.ok(demo.length >= 2);
  for (const c of demo) {
    assert.ok(c.name && c.phone && fill.isFakePhone(c.phone) && c.dueDate, c.id + ' filled');
    const t = s.txns.filter((x) => x.custId === c.id && !x.voided);
    assert.ok(t.length >= 3, c.id + ' has txns');
  }
  const c901 = s.customers.find((c) => c.id === 'C901');
  assert.deepStrictEqual([...new Set(s.txns.filter((t) => t.custId === 'C901').map((t) => t.type))].sort(), ['credit', 'payment']);
  assert.match(c901.phone, /^987650\d{4}$/);
  assert.strictEqual(new Set(s.customers.map((c) => c.phone).filter(Boolean)).size, s.customers.filter((c) => c.phone).length, 'phones unique');
  assert.ok(!fill.isFakePhone('9823012345') && fill.isFakePhone('9876500001') && fill.isFakePhone('9999999999'));
});

test('fill-demo: idempotent (second run changes nothing) and the app still works on the result', () => {
  const s = mixedKhata();
  fill.fillDemo(s, { today: TODAY });
  const once = plain(s);
  assert.deepStrictEqual(fill.fillDemo(s, { today: TODAY }), []);
  assert.deepStrictEqual(plain(s), once);
  const r = C.runAction(s, 'owner', { text: 'Sharma ji ne 2 maggi liya', source: 'text' });
  assert.ok(r);
});

test('fill-demo script: dry run writes nothing, --apply writes, then nothing left; also via STORE=pg-schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'));
  const f = path.join(dir, 'gupta.json'); const st = mixedKhata(); fs.writeFileSync(f, JSON.stringify(st));
  const lines = [], out = (l) => lines.push(l);
  assert.strictEqual(await fill.run([f], {}, out, { today: TODAY }), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), st);
  assert.match(lines.join('\n'), /dry run/);
  assert.strictEqual(await fill.run([f, '--apply'], {}, out, { today: TODAY }), 0);
  const filled = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.notDeepStrictEqual(filled, st);
  lines.length = 0;
  assert.strictEqual(await fill.run([f, '--apply'], {}, out, { today: TODAY }), 0);
  assert.match(lines.join('\n'), /nothing to fill/);
  if (!URL) return;
  await reset();
  const s = await createPgSchemaStore(URL, 'gupta'); s.save(st); await s.flush(); await s.close();
  const env = { DATABASE_URL: URL, STORE: 'pg-schema' };
  assert.strictEqual(await fill.run(['--shop', 'gupta', '--apply'], env, out, { today: TODAY }), 0);
  const back = await createPgSchemaStore(URL, 'gupta'); assert.deepStrictEqual(back.load(), filled); await back.close();
  const p = pool();
  const miss = await p.query('SELECT count(*) FROM gupta.items WHERE in_price_book AND (units IS NULL OR units = \'\' OR trader_rate IS NULL OR trader_rate >= customer_rate)');
  assert.strictEqual(+miss.rows[0].count, 0, 'every item has units and a trader rate below the customer rate');
  const real = await p.query("SELECT name, phone, due_date FROM gupta.customers WHERE id = 'C900'");
  assert.deepStrictEqual(real.rows[0], { name: 'Real Ramesh', phone: '9823012345', due_date: null });
  await p.end();
});
