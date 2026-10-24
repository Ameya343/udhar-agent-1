// The demo shops: Gupta Kirana, Zafar Sasta Bazaar and Sai Krupa Kirana, each with its own customers, and the script
// that puts a shop into its own database schema (the database part runs in pgschema tests with TEST_SCHEMA_DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');
const { run } = require('../dist-server/scripts/seed-shops.js');

const TODAY = '2026-10-25';

test('Zafar Sasta Bazaar and Sai Krupa Kirana Store: 10-12 customers each, open dues, suppliers, and the reminder ladder', () => {
  for (const [id, name, n] of [['zafar', 'Zafar Sasta Bazaar', 12], ['saikrupa', 'Sai Krupa Kirana Store', 11]]) {
    const s = C.freshShop(id, TODAY);
    assert.equal(s.shop.name, name);
    assert.equal(s.customers.length, n, name);
    assert.ok(n >= 10 && n <= 12);
    assert.equal(new Set(s.customers.map((c) => c.name)).size, n, 'names are unique');
    const d = C.dashboard(s, 30);
    assert.ok(d.outstanding > 0 && d.owingCount >= 6, name + ' has open udhaar');
    assert.ok(d.overdue.length >= 2, name + ' has late payers');
    assert.ok(s.wholesalers.length >= 2, name + ' has suppliers');
    const reminders = C.runAction(s, 'nextDay').result.filter((m) => m.kind === 'reminder');
    assert.ok(reminders.length >= 2, name + ' sends reminders on the next morning');
  }
  // every shop keeps its own customers
  const names = (id) => new Set(C.freshShop(id, TODAY).customers.map((c) => c.name));
  const g = names('gupta'), z = names('zafar'), k = names('saikrupa');
  for (const x of z) assert.ok(!g.has(x) && !k.has(x), x);
  for (const x of k) assert.ok(!g.has(x), x);
});

test('seed-shops script: needs known shop ids and DATABASE_URL, never writes without them', async () => {
  const lines = []; const out = (l) => lines.push(l);
  assert.equal(await run([], {}, out), 2);
  assert.match(lines.pop(), /usage: .*zafar.*saikrupa/);
  assert.equal(await run(['zafar', 'nope'], { DATABASE_URL: 'postgres://x' }, out), 2);
  assert.match(lines.pop(), /unknown shop nope/);
  assert.equal(await run(['zafar', 'saikrupa', '--apply'], {}, out), 2);
  assert.match(lines.pop(), /DATABASE_URL is not set/);
});
