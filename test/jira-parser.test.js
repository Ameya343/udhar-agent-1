// Stress Test 1 parser bugs (KAN-15 to KAN-20, KAN-45 to KAN-64): the rules never guess money.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

function shop() {
  const s = C.freshShop('gupta', '2026-10-08');
  C.runAction(s, 'owner', { text: 'Ramesh ne 500 ka saman liya' }); C.runAction(s, 'owner', { text: 'haan' });
  s.lastAction = null; s.lastWrite = null;
  return s;
}
function run(s, ...texts) {
  const n = s.txns.length, m = s.messages.length;
  for (const text of texts) C.runAction(s, 'owner', { text });
  return {
    txns: s.txns.slice(n).map((t) => t.type + ' ' + C.getCust(s, t.custId).name + ' ' + t.amount + (t.date !== s.today ? ' @' + t.date : '')),
    reply: s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n')
  };
}
const bal = (s, name) => Math.round(C.balance(s, s.customers.find((c) => c.name === name).id));

test('KAN-15 / KAN-16 / KAN-17: "nahi diye", a question, "kal dega" write nothing', () => {
  for (const t of ['Ramesh ne 500 nahi diye', 'Ramesh ne 500 diye kya?']) assert.deepStrictEqual(run(shop(), t).txns, [], t);
  const s = shop(); const r = run(s, 'Ramesh kal 500 dega');
  assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /wada/);
  assert.equal(s.customers.find((c) => c.name === 'Ramesh').dueDate, '2026-10-09');
  assert.deepStrictEqual(run(shop(), 'Ramesh 500 dega').txns, []);
});

test('KAN-18 / KAN-50 / KAN-55: maaf, kaat do and 10% kam karo ask first, then reduce', () => {
  let s = shop(); let r = run(s, 'Ramesh ka udhaar maaf');
  assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /maaf karoon \(write-off/);
  r = run(s, 'haan'); assert.equal(bal(s, 'Ramesh'), 0);
  assert.ok(s.txns[s.txns.length - 1].writeOff);
  s = shop(); r = run(s, 'Pappu ke 60 kaat do');
  assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /₹60 kam karun/);
  s = shop(); r = run(s, 'Ramesh ka 10% kam karo');
  assert.match(r.reply, /₹50 kam karun/);
});

test('KAN-19: "Ramesh Gupta" is asked about when only "Ramesh" has a khata', () => {
  const s = shop(); const r = run(s, 'Ramesh Gupta ne 200 liya');
  assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /naya/);
  assert.deepStrictEqual(run(s, 'naya').txns, ['credit Ramesh Gupta 200']);
});

test('KAN-20: a huge amount is confirmed first; zero is refused', () => {
  const s = shop(); let r = run(s, 'Ramesh ne 99999999 ka saman liya');
  assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /bahut badi rakam/);
  assert.deepStrictEqual(run(s, 'haan').txns, ['credit Ramesh 99999999']);
  assert.deepStrictEqual(run(shop(), 'Ramesh ne 0 liya').txns, []);
});

test('KAN-45 / KAN-48 / KAN-54: phone numbers are never amounts', () => {
  let s = shop(); let r = run(s, 'Ramesh ka number 98765 43210');
  assert.deepStrictEqual(r.txns, []); assert.equal(s.customers.find((c) => c.name === 'Ramesh').phone, '9876543210');
  r = run(shop(), 'Ramesh ka number 12345'); assert.deepStrictEqual(r.txns, []); assert.match(r.reply, /galat/);
  s = shop(); r = run(s, 'Ramesh 9876543210 ne 200 liya');
  assert.deepStrictEqual(r.txns, ['credit Ramesh 200']); assert.equal(s.customers.find((c) => c.name === 'Ramesh').phone, '9876543210');
});

test('KAN-47: "500 ka saman liya, usme se 200 de diye" is udhaar then jama', () => {
  const s = shop(); const r = run(s, 'Sharma ji ne 500 ka saman liya, usme se 200 de diye');
  assert.deepStrictEqual(r.txns, ['credit Sharma ji 500', 'payment Sharma ji 200']);
  assert.ok(!(s.prices || {}).usme);
});

test('KAN-49 / KAN-51: payment verbs and "ko ... cash diye"', () => {
  for (const t of ['रमेश ने 300 लौटाए', 'Ramesh ne 100 diyee', 'Ramesh settled 200']) assert.match(run(shop(), t).txns[0], /^payment Ramesh/, t);
  assert.deepStrictEqual(run(shop(), 'Iqbal bhai ne 200 ada kiye').txns, ['payment Iqbal bhai 200']);
  assert.deepStrictEqual(run(shop(), 'Ramesh ko 200 cash diye').txns, ['credit Ramesh 200']);
});

test('KAN-52 / KAN-53 / KAN-61: amounts', () => {
  assert.deepStrictEqual(run(shop(), 'Pappu ne paune do sau ka saman liya').txns, ['credit Pappu 175']);
  for (const t of ['Ramesh ne 200 300 liya', 'Ramesh ne 200-300 liya', 'Sharma ji ne 5 0 0 liya', 'Sharma ji ne 1e5 liya', 'Sharma ji ne 0x1F4 liya']) assert.deepStrictEqual(run(shop(), t).txns, [], t);
  assert.deepStrictEqual(run(shop(), 'Ramesh ne 99.99 diye').txns, ['payment Ramesh 100']);
});

test('KAN-56 / KAN-64: festival and past dates', () => {
  const s = shop(); run(s, 'Ramesh ne 100 liya, Diwali pe dega');
  const t = s.txns[s.txns.length - 1];
  assert.equal(t.dueDate, '2026-11-08'); assert.ok(!t.items);
  assert.deepStrictEqual(run(shop(), 'Sharma ji ne 500 diye the kal').txns, ['payment Sharma ji 500 @2026-10-07']);
  const s2 = shop(); const m0 = s2.messages.length; run(s2, 'sabko kal yaad dila dena');
  assert.ok(!s2.messages.slice(m0).some((m) => m.from === 'agent' && m.to !== 'owner'), 'nothing sent today');
  assert.equal(s2.remindAllOn, '2026-10-09');
  const before = s2.messages.length; C.runAction(s2, 'nextDay');
  assert.ok(s2.messages.slice(before).some((m) => /reminder bhej diya/.test(m.text)));
});

test('KAN-57: two people and the biggest debtor', () => {
  assert.match(run(shop(), 'Ramesh aur Pappu dono ka hisaab batao').reply, /Ramesh: ₹500[\s\S]*Pappu: ₹170/);
  assert.match(run(shop(), 'sabse zyada kiska baaki').reply, /Sabse zyada baaki/);
});

test('KAN-58 / KAN-59: loose yes, a dropped question is said, no double entry after a new customer', () => {
  let s = shop(); assert.deepStrictEqual(run(s, 'Zubair ne 300 liya', 'ha bhai likh do').txns, ['credit Zubair 300']);
  s = shop(); const r = run(s, 'Zubair ne 300 liya', 'Pappu ne 100 liya');
  assert.match(r.reply, /Zubair wala ₹300 nahi likha/);
  s = shop(); assert.deepStrictEqual(run(s, 'Zubair ne 300 liya', 'haan', 'Zubair ne 300 liya').txns, ['credit Zubair 300']);
});

test('KAN-60: junk words never become items or rates', () => {
  for (const t of ['Add 250 to Ramesh\'s account', 'Ramesh ne 100 lia', 'Sharma ji ki wife ne 200 liya', 'Sharma ji ke bete ne 200 ka saman liya']) {
    const s = shop(); run(s, t);
    const tx = s.txns[s.txns.length - 1];
    assert.ok(!tx.lines && !tx.items, t + ': ' + JSON.stringify(tx.lines || tx.items));
  }
});

test('KAN-62 / KAN-63: named delete asks; common phrases get a clear answer', () => {
  const s = shop(); assert.match(run(s, 'Ramesh ki last entry hata do').reply, /hataun\?/); assert.equal(bal(s, 'Ramesh'), 500);
  assert.match(run(shop(), 'show me all dues').reply, /Kul baaki/);
  assert.match(run(shop(), 'aadha de diya').reply, /aadha/);
  assert.match(run(shop(), 'khata band karo').reply, /Kiska khata band/);
  assert.doesNotMatch(run(shop(), 'doodh aur bread liya').reply, /"Bread" naya grahak/);
  assert.deepStrictEqual(run(shop(), 'Sharma ji 5 baje aayenge').txns, []);
});
