// The owner says the shop's rates once ("chawal ₹30 kilo, 20 wale chips teen ..."): they become the default rates, and
// "ye rate Sarthak ko bhej do" (same message or within 10 minutes) bills that customer from them through the list flow.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const A = 'चावल ₹30 किलो, तुअर दाल ₹25 किलो, shampoo bottle ₹60 ..., 20 वाले chips तीन और ₹80 लीटर दूध। ये rate सारसक को बता दो और total bill उसको भेज दो।';
const B = 'तोरदॉल चालीस, चावल तीस, shampoo साठ, anti-dandruff shampoo अस्सी, चिप्स बीस, अ दूध अस्सी रुपए लीटर।';
const Cmd = 'यह rate सार्थक को भेज दो और उसको पूरा bill बनाकर दे दो।';

function shop(extra, only) {
  const st = C.createState({}); C.seedDemo(st, 'gupta');
  for (const [id, name, phone] of (only ? [] : [['C900', 'Sarthak', '9876501234']]).concat(extra || [])) {
    st.customers.push({ id, name, key: name.toLowerCase(), phone, dueDate: null, reminderLevel: 0, lastReminder: null });
  }
  return st;
}
function say(st, text) {
  const n = st.messages.length, before = st.txns.length;
  C.runAction(st, 'owner', { text, source: 'voice' });
  const out = st.messages.slice(n).filter((m) => m.from === 'agent');
  return { owner: out.filter((m) => m.to === 'owner').map((m) => m.text).join('\n'), toSarthak: out.filter((m) => m.to === 'C900'), added: st.txns.slice(before) };
}
const noJunk = (st) => { for (const k of ['usako', 'usko', 'rupae', 'leetar', 'litar', 'dudh rupae litar', 'rate sarasak']) assert.ok(!st.prices[k], k + ' is not an item'); };

test('A: rates said once are saved and Sarthak (heard "सारसक") gets the bill', () => {
  const st = shop();
  const r = say(st, A);
  assert.doesNotMatch(r.owner, /yaad nahi|Thoda saaf/);
  assert.match(r.owner, /Rate yaad kar liye: Chawal ₹30\/kilo, Tuar daal ₹25\/kilo, Shampoo ₹60\/bottle, Chips ₹20, Doodh ₹80\/litre/);
  assert.equal(st.prices.chaval.rate, 30); assert.equal(st.prices.chaval.unit, 'kg');
  assert.equal(st.prices['tuar dal'].rate, 25); assert.equal(st.prices.shampu.rate, 60); assert.equal(st.prices.chips.rate, 20);
  assert.equal(st.prices.dudh.rate, 80); assert.equal(st.prices.dudh.unit, 'l');
  noJunk(st);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].custId, 'C900'); assert.equal(r.added[0].amount, 255); // 30 + 25 + 60 + 3x20 + 80
  assert.deepEqual(r.added[0].lines.map((l) => [l.name, l.qty, l.price]), [['chawal', 1, 30], ['tuar daal', 1, 25], ['shampoo', 1, 60], ['chips', 3, 60], ['doodh', 1, 80]]);
  assert.equal(r.toSarthak.length, 1); assert.equal(r.toSarthak[0].kind, 'entry-check');
  assert.match(r.toSarthak[0].text, /Chips ×3 ₹60/); assert.match(r.toSarthak[0].text, /haan \/ galat/);
  assert.match(r.owner, /Sarthak ka bill: ₹255/);
});

test('B: Hindi number words become rates; nothing is asked, nobody is billed', () => {
  const st = shop();
  const r = say(st, B);
  assert.doesNotMatch(r.owner, /yaad nahi/);
  assert.match(r.owner, /^📝 Rate yaad kar liye: .*Shampoo ₹60, Anti-dandruff shampoo ₹80, Chips ₹20, Doodh ₹80\/litre/);
  assert.equal(st.prices.chaval.rate, 30); assert.equal(st.prices.chaval.unit, 'kg'); // keeps the kilo it is sold by
  assert.equal(st.prices.shampu.rate, 60); assert.equal(st.prices['antidandruf shampu'].rate, 80);
  assert.equal(st.prices.chips.rate, 20); assert.equal(st.prices.dudh.rate, 80); assert.equal(st.prices.dudh.unit, 'l');
  noJunk(st);
  assert.equal(r.added.length, 0); assert.equal(r.toSarthak.length, 0);
});

test('C: "यह rate सार्थक को भेज दो" bills Sarthak from the last rate list', () => {
  const st = shop();
  say(st, B);
  const r = say(st, Cmd);
  assert.doesNotMatch(r.owner, /Thoda saaf|samajh nahi/);
  assert.equal(r.added.length, 1); assert.equal(r.added[0].custId, 'C900');
  assert.equal(r.added[0].amount, 40 + 30 + 60 + 80 + 20 + 80);
  assert.equal(r.toSarthak.length, 1);
  assert.match(r.owner, /Sarthak ka bill: ₹310/);
});

test('C after more than 10 minutes uses no old list', () => {
  const st = shop();
  say(st, B);
  st.rateSay.ts -= 11 * 60 * 1000;
  const r = say(st, Cmd);
  assert.equal(r.added.length, 0); assert.equal(r.toSarthak.length, 0);
});

test('a rate list with "bhej do" but no customer named asks who', () => {
  const st = shop();
  const r = say(st, 'चावल ₹30 किलो, चिप्स ₹20। total bill भेज दो।');
  assert.match(r.owner, /Rate yaad kar liye: Chawal ₹30\/kilo, Chips ₹20/);
  assert.match(r.owner, /Kisko bill bhejna hai/);
  assert.equal(r.added.length, 0);
});

test('two customers sound like the name: asked which, nobody billed', () => {
  const st = shop([['C901', 'Sarthak Jain', '9876501235'], ['C902', 'Sarthak Patil', '9876501236']], true);
  const r = say(st, 'चावल ₹30 किलो, चिप्स ₹20। ये rate सार्थक को बता दो और bill उसको भेज दो');
  assert.equal(r.added.length, 0);
  assert.match(r.owner, /Kisko bill bhejna hai\? 1\. .*2\. /);
});

test('people with amounts are not rates', () => {
  const st = shop();
  say(st, 'verma 250, pappu 120');
  assert.ok(!st.prices.verma && !st.prices.papu);
});

for (const route of ['udhaar', 'list', 'unknown', 'remind']) {
  test('AI route "' + route + '" still saves the rates and bills Sarthak (A)', () => {
    const st = shop();
    const r = C.handleOwnerMessage(st, A, { source: 'voice', intent: { intent: 'unknown', parser: 'llm', llmIntent: route, confidence: 0.9 } });
    assert.equal(st.prices.chips.rate, 20);
    assert.equal(st.txns.filter((t) => t.custId === 'C900' && !t.voided).map((t) => t.amount).join(), '255');
    assert.ok(r.messages.some((m) => m.to === 'owner' && /Sarthak ka bill: ₹255/.test(m.text)));
  });
}
