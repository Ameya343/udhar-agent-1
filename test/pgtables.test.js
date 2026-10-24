'use strict';
// STORE=pg-tables. Needs a scratch Postgres reached as a role that is NOT a superuser (superusers skip Row-Level
// Security): TEST_DATABASE_URL=postgres://khata:pw@localhost/khata_test. Skipped when unset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const T = require('../dist-server/server/tables.js');
const { createPgTablesStore, pgTypes } = require('../dist-server/server/store.js');
const { migrate } = require('../dist-server/scripts/migrate.js');
const imp = require('../dist-server/scripts/import-json-to-pg.js');

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'TEST_DATABASE_URL not set';
const TODAY = '2025-01-15';
const TABLES = ['customer_txns', 'customers', 'trader_txns', 'traders', 'items', 'messages', 'orders', 'shop_extras', 'shops', 'schema_migrations'];
const plain = (x) => JSON.parse(JSON.stringify(x));

function pool() { const pg = require('pg'); return new pg.Pool({ connectionString: URL, types: pgTypes(pg) }); }
async function reset() {
  const p = pool();
  await p.query('DROP TABLE IF EXISTS ' + TABLES.join(', ') + ' CASCADE');
  await p.end();
}

// A khata that has been used: udhaar, payments, a void, a supplier bill with item lines, a supplier payment, stock
// orders, a vouched newcomer, a removed customer, learned rates, odd values that do not fit their column.
function usedKhata(id) {
  const s = C.freshShop(id || 'gupta', TODAY);
  const say = (t) => C.runAction(s, 'owner', { text: t, source: 'text' });
  say('Sharma ji ne 340 ka saaman liya, Friday ko denge');
  say('Iqbal bhai ne 200 diye');
  say('Naya grahak Pappu ne 2 kg cheeni 90 aur 1 kg atta 44 liya');
  say('Agrawal traders se 10 kg cheeni 400, 5 kg dal 600 udhaar, 20 tareekh tak');
  say('Gopal dairy se 20 litre doodh 1000 udhaar');
  say('Agrawal traders ko 500 diye');
  s.wholesalers[0].phone = '9822700010'; s.wholesalers[0].wa = true;
  say('Agrawal se 10 kg aata mangwao');
  say('ok');
  s.txns[1].voided = true;
  s.customers[2].removed = TODAY;
  s.customers[3].vouch = { by: s.customers[0].id, date: TODAY };
  s.customers[3].guest = true;
  s.customers[4].removed = true;                 // not a date: kept in extra
  s.txns[0].amount = 340.25; s.txns[2].items = [{ name: 'cheeni', qty: 2 }];
  s.txns[3].custId = 'C999';                     // a customer no longer in the list
  s.customers[5].phone = undefined; delete s.customers[5].phone; // absent field stays absent
  s.customers[6].dueDate = 'kal';                // not a date
  s.orders = [{ id: 'O001', custId: 'C001', status: 'new', date: TODAY, lines: [{ name: 'doodh', qty: 1 }] }];
  s.ownerPhone = '9822000000';
  s.custom = { anything: [1, 'two', null] };
  return plain(s);
}

test('pure mapping round-trips a used khata', () => {
  const st = usedKhata();
  const { shop, tables, prices } = T.stateToRows(st);
  const items = (prices || []).map((p) => Object.assign({ in_price_book: true }, p));
  assert.deepStrictEqual(T.rowsToState(shop, plain(tables), items), st);
  assert.ok(tables.trader_txns.some((r) => r.type === 'payment'), 'supplier payment mapped');
  assert.ok(tables.traders.some((r) => r.kind === 'supplier'), 'supplier known only from the khata becomes a trader');
});

test('migrations: apply once, idempotent, tables and RLS in place', { skip }, async () => {
  await reset();
  const p = pool();
  assert.deepStrictEqual(await migrate(p), ['001_shop_tables.sql']);
  assert.deepStrictEqual(await migrate(p), []);
  const r = await p.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname", [TABLES.slice(0, 9)]);
  assert.strictEqual(r.rows.length, 9);
  for (const row of r.rows) assert.ok(row.relrowsecurity && row.relforcerowsecurity, row.relname + ' has forced RLS');
  const u = await p.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'items_shop_name_uq'");
  assert.match(u.rows[0].indexdef, /UNIQUE.*shop_id, lower\(name\)/);
  await p.end();
});

test('round-trip through the tables loses nothing, and a second save writes only what changed', { skip }, async () => {
  await reset();
  const st = usedKhata('gupta');
  const a = await createPgTablesStore(URL, 'gupta');
  assert.strictEqual(a.load(), null);
  a.save(st); await a.flush(); assert.strictEqual(a.lastError, null);
  await a.close();
  const b = await createPgTablesStore(URL, 'gupta');
  assert.deepStrictEqual(b.load(), st);
  const p = pool();
  const counts = await b.withShop(async (c) => {
    const q = async (t) => +(await c.query('SELECT count(*) FROM ' + t)).rows[0].count;
    return { customers: await q('customers'), txns: await q('customer_txns'), traders: await q('traders'), ttx: await q('trader_txns'), items: await q('items') };
  });
  assert.strictEqual(counts.customers, st.customers.length);
  assert.strictEqual(counts.txns, st.txns.length);
  assert.strictEqual(counts.ttx, st.supplies.length + st.supplierPays.length);
  // a change to one customer only: txns are not rewritten (their created_at stays)
  const before = await b.withShop((c) => c.query("SELECT created_at FROM trader_txns ORDER BY id LIMIT 1"));
  const s2 = b.load(); s2.messages.push({ id: 'Wx', to: 'owner', from: 'agent', text: 'hi', date: TODAY });
  b.save(s2); await b.flush(); assert.strictEqual(b.lastError, null);
  const after = await b.withShop((c) => c.query("SELECT created_at FROM trader_txns ORDER BY id LIMIT 1"));
  assert.deepStrictEqual(after.rows, before.rows);
  await b.close();
  const c3 = await createPgTablesStore(URL, 'gupta'); assert.deepStrictEqual(c3.load(), plain(s2)); await c3.close();
  await p.end();
});

test('two shops are isolated, and RLS hides the other shop at the SQL level', { skip }, async () => {
  await reset();
  const a = await createPgTablesStore(URL, 'gupta'), b = await createPgTablesStore(URL, 'sharma');
  const sa = usedKhata('gupta'), sb = plain(C.freshShop('sharma', TODAY));
  a.save(sa); b.save(sb); await a.flush(); await b.flush();
  assert.strictEqual(a.lastError, null); assert.strictEqual(b.lastError, null);
  sa.shop.name = 'Gupta 2'; a.save(sa); await a.flush();
  await a.close(); await b.close();
  const a2 = await createPgTablesStore(URL, 'gupta'), b2 = await createPgTablesStore(URL, 'sharma');
  assert.deepStrictEqual(a2.load(), sa); assert.deepStrictEqual(b2.load(), sb);
  // same customer ids (C001) in both shops, no clash; each scoped connection sees only its own rows
  const seen = await b2.withShop((c) => c.query('SELECT DISTINCT shop_id FROM customers'));
  assert.deepStrictEqual(seen.rows, [{ shop_id: 'sharma' }]);
  const shops = await b2.withShop((c) => c.query('SELECT id FROM shops'));
  assert.deepStrictEqual(shops.rows, [{ id: 'sharma' }]);
  // writing another shop's row from a scoped connection is refused
  await assert.rejects(b2.withShop((c) => c.query("INSERT INTO shop_extras (shop_id, key, value) VALUES ('gupta', 'x', '1')")), /row-level security/);
  await assert.rejects(b2.withShop((c) => c.query("UPDATE customers SET name = 'hacked' WHERE shop_id = 'gupta' RETURNING 1").then((r) => { if (r.rowCount) throw new Error('updated'); throw new Error('row-level security: 0 rows'); })), /row-level security/);
  // no app.shop_id: nothing visible
  const p = pool();
  assert.strictEqual(+(await p.query('SELECT count(*) FROM customers')).rows[0].count, 0);
  await p.end(); await a2.close(); await b2.close();
});

test('item rates: customer and trader rates are learned separately', { skip }, async () => {
  await reset();
  const s = usedKhata('gupta');
  const st = await createPgTablesStore(URL, 'gupta');
  st.save(s); await st.flush(); assert.strictEqual(st.lastError, null);
  const item = (name) => st.withShop((c) => c.query('SELECT * FROM items WHERE lower(name) = lower($1)', [name])).then((r) => r.rows[0]);
  // the rate book (customer side) and the supplier bill (trader side) both land on the same item row
  const cheeni = await item(T.itemKey('cheeni'));
  assert.strictEqual(Number(cheeni.customer_rate), s.prices[T.itemKey('cheeni')].rate);
  assert.strictEqual(Number(cheeni.trader_rate), 40); // 10 kg for 400
  assert.strictEqual(cheeni.trader_rate_updated_at, TODAY);
  // learning a trader rate leaves the customer rate alone, and the other way round
  await st.withShop((c) => T.learnItemRate(c, 'gupta', { name: 'cheeni', side: 'trader', rate: 41.5, unit: 'kg', at: '2025-01-16' }));
  let r = await item(T.itemKey('cheeni'));
  assert.strictEqual(Number(r.trader_rate), 41.5); assert.strictEqual(Number(r.customer_rate), Number(cheeni.customer_rate));
  await st.withShop((c) => T.learnItemRate(c, 'gupta', { name: 'Cheeni', side: 'customer', rate: 48, at: '2025-01-16' }));
  r = await item(T.itemKey('cheeni'));
  assert.strictEqual(Number(r.customer_rate), 48); assert.strictEqual(Number(r.trader_rate), 41.5);
  const n = await st.withShop((c) => c.query('SELECT count(*) FROM items WHERE lower(name) = $1', [T.itemKey('cheeni')]));
  assert.strictEqual(+n.rows[0].count, 1, 'one row per item, case-insensitive');
  // a brand-new item learned only from a trader is not put into the app's rate book
  await st.withShop((c) => T.learnItemRate(c, 'gupta', { name: 'saboodana', side: 'trader', rate: 70, unit: 'kg', at: TODAY }));
  await st.close();
  const again = await createPgTablesStore(URL, 'gupta');
  const loaded = again.load();
  assert.strictEqual(loaded.prices[T.itemKey('cheeni')].rate, 48, 'the learned selling rate reaches the app');
  assert.ok(!loaded.prices[T.itemKey('saboodana')]);
  // an older supplier bill does not overwrite a newer buying rate on save
  again.save(loaded); await again.flush();
  r = await again.withShop((c) => c.query('SELECT trader_rate FROM items WHERE name = $1', [T.itemKey('cheeni')]));
  assert.strictEqual(Number(r.rows[0].trader_rate), 41.5);
  await assert.rejects(again.withShop((c) => T.learnItemRate(c, 'gupta', { name: 'x', side: 'both', rate: 1 })));
  await again.close();
});

test('import script targets the tables with STORE=pg-tables', { skip }, async () => {
  await reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  const f = path.join(dir, 'k.json'); const st = usedKhata('gupta'); fs.writeFileSync(f, JSON.stringify(st));
  const env = { DATABASE_URL: URL, STORE: 'pg-tables' }, lines = [], out = (l) => lines.push(l);
  assert.strictEqual(await imp.run([f, 'gupta'], env, out), 0);
  let s = await createPgTablesStore(URL, 'gupta'); assert.strictEqual(s.load(), null); await s.close();
  assert.strictEqual(await imp.run([f, 'gupta', '--apply'], env, out), 0);
  s = await createPgTablesStore(URL, 'gupta'); assert.deepStrictEqual(s.load(), st); await s.close();
  assert.strictEqual(await imp.run([f, 'gupta', '--apply'], env, out), 1);
  assert.strictEqual(await imp.run([f, 'gupta', '--apply', '--force'], env, out), 0);
  assert.ok(!lines.join('\n').includes(URL));
});
