// Editing a list already written: "Krish ki list mein 2 Maggi jod do", "... se doodh hata do", "... aata 90 ka tha",
// "Krish ki list badlo: ...". The same entry changes (no double counting) and Krish gets the updated list once.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');
const U = require('../dist-server/core/understand.js');

const TODAY = '2026-10-08';
function shop(phone) {
  const st = C.freshShop('gupta', TODAY);
  st.customers.push({ id: 'C900', name: 'Krish', key: 'krish', phone: phone === undefined ? '9822700000' : phone, wa: true, vpas: [], dueDate: null, createdAt: TODAY });
  st.txns.push({ id: 'T900', custId: 'C900', type: 'credit', amount: 1330, items: '', date: '2026-10-01', dueDate: '2026-10-20', note: 'seed', source: 'text' });
  return st;
}
function say(st, text) {
  const n = st.messages.length, before = st.txns.length;
  C.runAction(st, 'owner', { text, source: 'text' });
  const out = st.messages.slice(n).filter((m) => m.from === 'agent');
  return { owner: out.filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), toKrish: out.filter((m) => m.to === 'C900'), added: st.txns.slice(before) };
}
const bal = (st) => C.balance(st, 'C900');

test('list edit: add, remove and re-price change the same entry and send Krish one updated list', () => {
  const st = shop();
  const t = say(st, 'Krish ki list: 2 kilo aata 80, ek Parle-G 10, doodh 30').added[0];
  assert.equal(bal(st), 1450);

  let r = say(st, 'Krish ki list mein 2 Maggi 24 aur jod do');
  assert.equal(r.added.length, 0);
  assert.equal(t.amount, 144); assert.equal(bal(st), 1474);
  assert.equal(r.toKrish.length, 1);
  assert.equal(r.toKrish[0].kind, 'entry-check'); assert.equal(r.toKrish[0].txnId, t.id);
  assert.equal(r.toKrish[0].text,
    'Gupta Kirana Store: aapki list badli gayi\n- Aata 2 kg ₹80\n- Parle-G ₹10\n- Doodh ₹30\n- Maggi ×2 ₹24\n' +
    'Is baar: ₹144 | Kul udhaar: ₹1,474\nSahi hai? haan / galat likhein');
  assert.match(r.owner, /✏️ Krish ki list badli .*₹120 → ₹144/);

  r = say(st, 'Krish ki list se doodh hata do');
  assert.equal(t.amount, 114); assert.equal(bal(st), 1444);
  assert.ok(!t.lines.some((l) => l.name === 'doodh'));
  assert.equal(r.toKrish.length, 1);

  r = say(st, 'Krish ki list mein aata 90 ka tha');
  assert.equal(t.amount, 124); assert.equal(t.lines[0].price, 90);
  assert.match(r.toKrish[0].text, /- Aata 2 kg ₹90/);

  r = say(st, 'Krish ki list badlo: 1 kilo cheeni 45, doodh 30');
  assert.equal(r.added.length, 0);
  assert.equal(t.amount, 75); assert.equal(bal(st), 1405);
  assert.equal(t.lines.length, 2);
});

test('list edit: unknown rate is asked before changing; no recent list or no number is told to the owner', () => {
  let st = shop();
  const t = say(st, 'Krish ki list: 2 kilo aata 80').added[0];
  let r = say(st, 'Krish ki list mein Zorbix jod do');
  assert.match(r.owner, /Zorbix kitne ka\?/); assert.equal(t.amount, 80); assert.equal(r.toKrish.length, 0);
  r = say(st, '15');
  assert.equal(t.amount, 95); assert.equal(r.toKrish.length, 1);

  st = shop();
  r = say(st, 'Krish ki list se doodh hata do');
  assert.match(r.owner, /Krish ki koi list pichhle 3 din mein nahi mili/);
  assert.equal(bal(st), 1330);

  st = shop(null);
  const t2 = say(st, 'Krish ki list: 2 kilo aata 80, doodh 30').added[0];
  r = say(st, 'Krish ki list se doodh hata do');
  assert.equal(t2.amount, 80); assert.equal(r.toKrish.length, 0);
  assert.match(r.owner, /number nahi hai/);
});

test('list edit: a new list is still a new list, and the rules fallback names list_edit', () => {
  const st = shop();
  assert.equal(C.listEditIntent(st, 'Krish ki list: 2 kilo aata 80, doodh 30 likh do'), null);
  assert.equal(C.listEditIntent(st, 'Krish ki list mein 2 Maggi aur jod do').op, 'add');
  assert.ok(U.OWNER_U.indexOf('list_edit') >= 0);
  assert.equal(U.rulesUnderstand(st, 'owner', 'Krish ki list se doodh hata do').intent, 'list_edit');
  assert.equal(U.normalize({ intent: 'list_edit', person: 'Krish' }, 'owner').intent, 'list_edit');
});
