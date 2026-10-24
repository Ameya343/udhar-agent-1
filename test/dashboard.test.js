// The owner dashboard: Grahak table rows (messages the agent sent per customer, latest items), the due calendar,
// supplier cards by category, and the Supplier tab's order box (same draft + owner confirm as WhatsApp).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');

const PAGE = path.join(__dirname, '../dist/udhaar-agent-standalone.html');
fs.existsSync(PAGE) || require('../build.js');
const TODAY = '2026-10-08';
const shop = () => C.freshShop('gupta', TODAY);

test('customer rows: balance, due date, status, masked phone, latest items, and messages the agent sent', () => {
  const s = shop();
  const before = C.customerRows(s).find((r) => r.name === 'Pappu');
  assert.equal(before.status, 'late');
  assert.equal(before.messagesSent, 0);
  assert.match(before.phone, /^98x+03$/);
  assert.ok(before.lastItems.length > 0);
  const out = C.runAction(s, 'nextDay').result; // morning reminders go out
  const sentTo = out.filter((m) => m.kind === 'reminder').map((m) => m.to);
  assert.ok(sentTo.length > 0);
  const rows = C.customerRows(s);
  for (const id of sentTo) {
    const r = rows.find((x) => x.id === id);
    assert.ok(r.reminders >= 1 && r.messagesSent >= r.reminders, r.name);
    assert.equal(r.lastMessage, s.today);
  }
  // a customer's own message and owner messages are not counted as "sent by the agent"
  const id = sentTo[0], n = C.customerMessageCount(s, id).sent;
  s.messages.push({ id: 'X1', to: 'agent', from: id, text: 'kal dunga', date: s.today, ts: 1 });
  assert.equal(C.customerMessageCount(s, id).sent, n);
  // the khata itself is unchanged by reading rows
  assert.equal(rows.find((x) => x.id === id).balance, Math.round(C.balance(s, id)));
});

test('due calendar: every pending customer lands on their expected pay date; late ones are marked', () => {
  const s = shop();
  const cal = C.dueCalendar(s, '2026-10');
  const all = Object.values(cal).flat();
  const owing = s.customers.filter((c) => !c.removed && C.balance(s, c.id) > 0);
  assert.equal(all.length, owing.length);
  assert.equal(all.reduce((a, x) => a + x.amount, 0), Math.round(C.totalOutstanding(s)));
  for (const [d, list] of Object.entries(cal)) for (const x of list) assert.equal(x.late, d < TODAY);
  assert.deepEqual(C.dueCalendar(s, '2027-01'), {});
});

test('supplier cards: grouped by category guessed from items, editable by the owner', () => {
  const s = shop();
  const cards = C.supplierCards(s);
  const by = Object.fromEntries(cards.map((c) => [c.name, c]));
  assert.equal(by['Shree Dairy'].category, 'Dairy');
  assert.equal(by['Modern Bakery'].category, 'Bakery');
  assert.equal(by['Agrawal Traders'].owed, 14000);
  const w = s.wholesalers.find((x) => x.name === 'Modern Bakery');
  C.runAction(s, 'wsCategory', { wsId: w.id, category: '  Bread & Pav  ' });
  assert.equal(C.supplierCards(s).find((c) => c.id === w.id).category, 'Bread & Pav');
  C.runAction(s, 'wsCategory', { wsId: w.id, category: '' });
  assert.equal(C.supplierCards(s).find((c) => c.id === w.id).category, 'Bakery');
  assert.throws(() => C.runAction(s, 'wsCategory', { wsId: 'nope', category: 'x' }));
});

test('no order box: supplier orders go through WhatsApp only; the dashboard actions are gone', () => {
  const s = shop();
  const w = s.wholesalers.find((x) => x.name === 'Agrawal Traders');
  assert.throws(() => C.runAction(s, 'wsOrder', { wsId: w.id, text: '10 kg atta' }));
  assert.throws(() => C.runAction(s, 'wsOrderAnswer', { orderIds: [], yes: true }));
  const html = fs.readFileSync(PAGE, 'utf8');
  for (const gone of ['id="orderBox"', 'id="orderDraft"', 'id="orderConfirm"', 'id="stmtBtn"', 'data-claim=']) assert.ok(!html.includes(gone), gone);
  assert.match(html, /ko order: 10 kg atta, 5 pkt maggi/);
  assert.match(html, /Answer these on WhatsApp/);
});

test('page: Home, Grahak and Supplier tabs only; no chat box, phone mockup, debug panel or focus switch', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const tabs = [...html.matchAll(/data-go="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tabs)], ['home', 'grahak', 'supplier']);
  for (const gone of ['id="chat"', 'id="cchat"', 'id="compose"', 'class="phone', 'focusToggle', 'data-go="hisaab"', 'Bahi-khata'])
    assert.ok(!html.includes(gone), gone);
  for (const id of ['kOut', 'kToday', 'kWeek', 'custTable', 'cal', 'supGroups']) assert.match(html, new RegExp('id="' + id + '"'), id);
});
