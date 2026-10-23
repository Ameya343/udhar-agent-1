// Owner corrections and several people in one message: a fix or undo never touches another person's entry,
// and a customer's name never becomes a bill item or a remembered rate.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core/agent-core.js');
const U = require('../core/understand.js');

function shop() {
  const s = C.createState({}); C.seedDemo(s, 'gupta');
  C.handleOwnerMessage(s, 'Sharma ji ne 340 ka saaman liya');
  C.handleOwnerMessage(s, 'Ramesh ne 500 ka saman liya'); // the owner's last entry is someone else's
  return s;
}
const say = (s, t, o) => C.handleOwnerMessage(s, t, o || {}).messages.filter((m) => m.to === 'owner').map((m) => m.text).join('\n');
const cust = (s, name) => s.customers.find((c) => c.name === name);
const live = (s, name) => s.txns.filter((t) => t.custId === cust(s, name).id && !t.voided && t.date === s.today);

for (const msg of ['galti ho gayi sharma ji ka 340 nahi 430 tha', 'sharma ji ka 340 galat hai 430 karo']) {
  test('fix changes only the named person\'s entry: ' + msg, () => {
    const s = shop();
    const r = say(s, msg);
    assert.match(r, /Sharma ji/); assert.match(r, /₹340/); assert.match(r, /₹430/);
    assert.doesNotMatch(r, /Hata diya/); assert.doesNotMatch(r, /Ramesh/);
    assert.deepStrictEqual(live(s, 'Sharma ji').map((t) => t.amount), [430]);
    assert.deepStrictEqual(live(s, 'Ramesh').map((t) => t.amount), [500]);
  });
}
test('fix with unknown person or missing entry asks and changes nothing', () => {
  const s = shop();
  const before = JSON.stringify(s.txns);
  assert.match(say(s, 'Ramu ka 340 nahi 430 tha'), /Kuch nahi badla/);
  assert.match(say(s, 'sharma ji ka 999 nahi 430 tha'), /Kuch nahi badla/);
  assert.match(say(s, '340 nahi 430 tha'), /Kiski entry/);
  assert.match(say(s, 'Sharma ji ka hisaab galat hai'), /Kuch nahi badla/);
  assert.strictEqual(JSON.stringify(s.txns), before);
});
test('named undo touches only that person; bare undo says whose', () => {
  const s = shop();
  assert.match(say(s, 'Sharma ji ki entry cancel'), /Hata diya: Sharma ji ka ₹340/);
  assert.deepStrictEqual(live(s, 'Ramesh').map((t) => t.amount), [500]);
  assert.match(say(s, 'galti ho gayi, last wala cancel'), /Hata diya: Ramesh ka ₹500/);
});
test('LLM undo naming a person never voids another person\'s entry', () => {
  const s = shop();
  const r = say(s, 'sharma ji wala galti', { intent: { intent: 'undo', name: 'Sharma ji', nameKey: 'sharma', parser: 'llm', llmIntent: 'undo', confidence: 0.9 } });
  assert.match(r, /Sharma ji/); assert.doesNotMatch(r, /Ramesh/);
  assert.deepStrictEqual(live(s, 'Ramesh').map((t) => t.amount), [500]);
});

for (const msg of ['verma ka 250 aur pappu ka 120 likh do', 'verma 250 pappu 120']) {
  test('two people, two entries: ' + msg, () => {
    const s = shop();
    const out = C.handleOwnerMessage(s, msg).messages;
    assert.deepStrictEqual(live(s, 'Verma ji').map((t) => t.amount), [250]);
    assert.deepStrictEqual(live(s, 'Pappu').map((t) => t.amount), [120]);
    assert.ok(!live(s, 'Verma ji')[0].lines, 'no bill lines on Verma');
    assert.ok(!(s.prices || {}).papu, 'Pappu is not a rate');
    assert.ok(!out.some((m) => m.to !== 'owner' && /Pappu/.test(m.text)), 'no bill with Pappu sent to anyone');
  });
}
test('unknown name in a multi entry asks and writes nothing', () => {
  const s = shop();
  const n = s.txns.length;
  assert.match(say(s, 'verma 250 ramu 100'), /Ramu kaun hai[\s\S]*Kuch nahi likha/);
  assert.strictEqual(s.txns.length, n);
});
test('a customer name never becomes an item even in a single entry', () => {
  const s = shop();
  say(s, 'Verma ji ka 250 pappu 120 likh do');
  assert.ok(!(s.prices || {}).papu);
  assert.ok(!s.txns.some((t) => t.lines && t.lines.some((l) => /pappu/i.test(l.name))));
});
test('LLM entries split into one entry per person; amounts must be in the message', () => {
  const s = shop();
  const u = U.normalize({ intent: 'udhaar', person: 'Verma ji', entries: [{ person: 'Verma ji', amount: 250, type: 'udhaar' }, { person: 'Pappu', amount: 120 }] }, 'owner');
  assert.strictEqual(u.entries.length, 2);
  const oi = Object.assign(U.toOwnerIntent(u, 'verma ka dhai sau, pappu ka 120'), { u, parser: 'llm' });
  C.handleOwnerMessage(s, 'verma ka dhai sau, pappu ka 120', { intent: oi });
  assert.deepStrictEqual(live(s, 'Verma ji').map((t) => t.amount), [250]);
  assert.deepStrictEqual(live(s, 'Pappu').map((t) => t.amount), [120]);
});
test('the owner prompt asks for entries', () => {
  const s = shop();
  assert.match(U.ownerMessages(s, 'x')[0].content, /entries/);
});

// naye log (vouching) is switched off for now: FEATURE_VOUCH, default off
test('vouching is off by default: no newcomer, no owner question, the message goes on as usual', () => {
  assert.strictEqual(C.FEATURES.vouch, false);
  const s = C.freshShop('gupta', '2026-10-07');
  const v = s.customers.find((c) => c.name === 'Verma ji');
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: v.id, text: 'Rahul 9876512345 mera roommate hai, main jaanta hoon' });
  assert.ok(!s.customers.some((c) => c.phone === '9876512345'), 'no guest khata made');
  const out = s.messages.slice(n);
  assert.ok(!out.some((m) => /pehchan|seema|kehte hain woh/i.test(m.text)), 'no vouch prompts');
  assert.ok(!(s.ownerAsks || []).some((a) => a.type === 'vouch'));
  assert.doesNotMatch(U.customerMessages(s, v, 'x', {})[0].content, /vouch/);
  assert.strictEqual(C.customerIntentFromLlm({ intent: 'vouch' }, 'Rahul 9876512345 mera dost hai').intent, 'question');
});
test('vouching on (FEATURE_VOUCH=1): the old flow works; turning it off parks a waiting question and keeps data', () => {
  C.FEATURES.vouch = true;
  try {
    const s = C.freshShop('gupta', '2026-10-07');
    const v = s.customers.find((c) => c.name === 'Verma ji');
    C.runAction(s, 'customer', { custId: v.id, text: 'Rahul 9876512345 mera roommate hai, main jaanta hoon' });
    const r = s.customers.find((c) => c.phone === '9876512345');
    assert.ok(r && r.vouch);
    assert.ok(s.ownerAsks.some((a) => a.type === 'vouch'));
    assert.match(U.customerMessages(s, v, 'x', {})[0].content, /vouch/);
    C.FEATURES.vouch = false;
    C.runAction(s, 'owner', { text: 'ok' });
    assert.strictEqual(r.guest, true, 'a parked vouch question is not answered by "ok"');
    assert.ok(r.vouch, 'vouch data kept');
    assert.ok(s.parkedAsks.some((a) => a.type === 'vouch'));
  } finally { C.FEATURES.vouch = false; }
});
