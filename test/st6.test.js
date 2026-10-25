// Regression tests for the KAN-120 to KAN-138 findings (25 Oct sweep): relatives, "Rs.300", balance questions with a
// number, refunds, overpayments, "shayad" and "3200 me se 1000". Each one on the rules path and, where the bug was
// on both, on the AI path with a mocked model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { createServer } = require('../dist-server/server/server.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-st6-'));
const shop = (d) => C.freshShop('gupta', d || '2026-10-20');
function owner(s, text) {
  const m = s.messages.length, n = s.txns.length;
  C.runAction(s, 'owner', { text });
  return { txns: s.txns.slice(n), reply: s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n'), toCust: s.messages.slice(m).filter((x) => x.from === 'agent' && x.to !== 'owner') };
}
const cust = (s, name) => s.customers.find((c) => c.name === name);
const bal = (s, name) => Math.round(C.balance(s, cust(s, name).id));
const wrote = (r) => r.txns.map((t) => t.type + ' ' + t.amount).join(',');

function aiShop(reply) {
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) });
  return createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, fetch, today: () => '2026-10-20' });
}
const model = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'unknown', items: [], amount: null, person: '', phone: '', due_date: '', canon: '', confidence: 0.9, ask: '' }, j);
async function aiOwner(srv, text) {
  const st = srv.getState(), m = st.messages.length, n = st.txns.length;
  const intent = await srv.brain.understandOwner(text);
  C.runAction(st, 'owner', { text, intent });
  return { txns: st.txns.slice(n), reply: st.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n'), toCust: st.messages.slice(m).filter((x) => x.from === 'agent' && x.to !== 'owner'), st };
}

test('KAN-120: a customer\'s relative is asked about, never written straight on the customer\'s khata', () => {
  for (const [text, who, amt] of [['Pappu ka bhai ne 400 ka saman liya', 'Pappu', 400], ['Pappu ka bhai 150 udhaar', 'Pappu', 150], ['Verma ji ka beta ne 400 ka saman liya', 'Verma ji', 400], ['Pappu ka bhai ne 250 diye', 'Pappu', 250]]) {
    const s = shop(), before = bal(s, who);
    const r = owner(s, text);
    assert.equal(r.txns.length, 0, text);
    assert.equal(bal(s, who), before, text);
    assert.match(r.reply, new RegExp(who + ' ke khate mein likhun'), text);
    assert.match(r.reply, /Abhi kuch nahi likha/, text);
    assert.equal(r.toCust.length, 0, text);
    assert.ok(s.pending, text);
  }
  // haan: on the customer's khata
  let s = shop(); owner(s, 'Pappu ka bhai ne 400 ka saman liya');
  let r = owner(s, 'haan');
  assert.equal(wrote(r), 'credit 400'); assert.equal(r.txns[0].custId, cust(s, 'Pappu').id);
  // naya: a khata of their own
  s = shop(); owner(s, 'Pappu ka bhai ne 400 ka saman liya');
  r = owner(s, 'naya');
  assert.equal(wrote(r), 'credit 400'); assert.equal(bal(s, 'Pappu'), 170); assert.ok(cust(s, 'Pappu ka bhai'));
  // nahi: nothing
  s = shop(); owner(s, 'Pappu ka bhai ne 400 ka saman liya');
  assert.equal(owner(s, 'nahi').txns.length, 0);
  // the customer's own entry is unchanged
  assert.equal(wrote(owner(shop(), 'Pappu ne 400 ka saman liya')), 'credit 400');
});

test('KAN-120: the AI path asks too when the model says udhaar for Pappu', async () => {
  const srv = aiShop(model({ intent: 'udhaar', person: 'Pappu', amount: 400 }));
  const r = await aiOwner(srv, 'Pappu ka bhai ne 400 ka saman liya');
  assert.equal(r.txns.length, 0);
  assert.match(r.reply, /Pappu ke khate mein likhun/);
});

test('KAN-121: "Rs.300" with no space is ₹300', () => {
  for (const [text, type] of [['Pappu ne Rs.300 diye', 'payment'], ['Pappu Rs.300 udhaar', 'credit'], ['pappu rs.300', 'credit'], ['Pappu ne Rs. 300 diye', 'payment'], ['Pappu ne RS.300 diye', 'payment'], ['Pappu ne INR.300 diye', 'payment']]) {
    assert.equal(wrote(owner(shop(), text)), type + ' 300', text);
  }
  assert.equal(C.parseOwnerMessage('Pappu ne Rs.300 diye', '2026-10-20').amount, 300);
  assert.equal(C.parseOwnerMessage('Pappu ne Rs.300.50 diye', '2026-10-20').roundedFrom, 300.5);
});

test('KAN-125: "Pappu ka kitna baaki hai? 500 tha na" shows the balance and writes nothing', async () => {
  for (const text of ['Pappu ka kitna baaki hai? 500 tha na', 'pappu ka kitna baki hai 500 tha na', 'Pappu ka kitna baaki hai, 500 hai kya?']) {
    const s = shop(), r = owner(s, text);
    assert.equal(r.txns.length, 0, text);
    assert.equal(r.toCust.length, 0, text);
    assert.match(r.reply, /Pappu ka baaki: ₹170/, text);
    assert.match(r.reply, /Kuch nahi likha/, text);
  }
  // the AI path: a model that says udhaar Pappu 500 still writes nothing and messages no one
  const srv = aiShop(model({ intent: 'udhaar', person: 'Pappu', amount: 500 }));
  const r = await aiOwner(srv, 'Pappu ka kitna baaki hai? 500 tha na');
  assert.equal(r.txns.length, 0);
  assert.equal(r.toCust.length, 0);
  assert.match(r.reply, /₹170/);
  // a plain entry with a question word in it is still an entry
  assert.equal(wrote(owner(shop(), 'Pappu ne 500 ka saman liya')), 'credit 500');
});

test('KAN-126: "Pappu ko 200 wapas diye" is money the shop gave back, so the balance goes up', async () => {
  for (const text of ['Pappu ko 200 wapas diye', 'Pappu ko 200 lauta diye', 'Pappu ko 200 vapas kiye', 'Pappu ko 200 refund kiye']) {
    const s = shop(), r = owner(s, text);
    assert.equal(wrote(r), 'credit 200', text);
    assert.equal(bal(s, 'Pappu'), 370, text);
  }
  // the customer paying back is still a payment
  assert.equal(wrote(owner(shop(), 'Pappu ne 100 wapas diye')), 'payment 100');
  assert.equal(wrote(owner(shop(), 'Pappu ne 100 lauta diye')), 'payment 100');
  // the AI calls it jama: the rules' refund wins
  const srv = aiShop(model({ intent: 'jama', person: 'Pappu', amount: 200 }));
  const r = await aiOwner(srv, 'Pappu ko 200 wapas diye');
  assert.equal(wrote(r), 'credit 200');
});

test('KAN-131: a payment far above the balance is asked first; haan writes it', () => {
  const s = shop();
  let r = owner(s, 'Pappu ne 99999 diye');
  assert.equal(r.txns.length, 0);
  assert.match(r.reply, /baaki sirf ₹170/);
  assert.match(r.reply, /haan/);
  r = owner(s, 'haan');
  assert.equal(wrote(r), 'payment 99999');
  const s2 = shop(); owner(s2, 'Pappu ne 99999 diye');
  assert.equal(owner(s2, 'nahi').txns.length, 0);
  assert.equal(bal(s2, 'Pappu'), 170);
  // everyday payments and a said advance are written at once
  assert.equal(wrote(owner(shop(), 'Patil bhau ne 3200 diye')), 'payment 3200');
  assert.equal(wrote(owner(shop(), 'Pappu ne 500 diye')), 'payment 500');
  assert.equal(wrote(owner(shop(), 'Sharma ji ne 6000 advance diye')), 'payment 6000');
});

test('KAN-137: "shayad" asks first, writes nothing and learns no rate', async () => {
  for (const text of ['Iqbal bhai ne shayad 400 liya tha', 'Pappu ne shayad 200 diye', 'Pappu ka 300 tha shayad', 'Meena didi ne 500 liya, pakka nahi']) {
    const s = shop(), rates = JSON.stringify(s.shop.prices || {}), r = owner(s, text);
    assert.equal(r.txns.length, 0, text);
    assert.equal(r.toCust.length, 0, text);
    assert.match(r.reply, /pakka/i, text);
    assert.doesNotMatch(r.reply, /Naya daam/, text);
    assert.equal(JSON.stringify(s.shop.prices || {}), rates, text);
  }
  // the AI path, whether the model says udhaar or unknown
  for (const m of [model({ intent: 'udhaar', person: 'Iqbal bhai', amount: 400 }), model({ intent: 'unknown' })]) {
    const r = await aiOwner(aiShop(m), 'Iqbal bhai ne shayad 400 liya tha');
    assert.equal(r.txns.length, 0);
    assert.doesNotMatch(r.reply, /Naya daam/);
  }
});

test('KAN-138: "3200 me se 1000 diye" and "700 hai na? usne 200 diye" write the money paid', async () => {
  let s = shop(), r = owner(s, 'Patil bhau ne 3200 me se 1000 diye');
  assert.equal(wrote(r), 'payment 1000'); assert.equal(bal(s, 'Patil bhau'), 2200);
  s = shop(); r = owner(s, 'Patil bhau ne 3200 mein se 1000 diye');
  assert.equal(wrote(r), 'payment 1000');
  s = shop(); r = owner(s, 'Meena didi ka 700 hai na? usne 200 diye');
  assert.equal(wrote(r), 'payment 200'); assert.equal(bal(s, 'Meena didi'), 500);
  s = shop(); r = owner(s, 'Meena didi ka 700 hai na usne 200 diye');
  assert.equal(wrote(r), 'payment 200');
  // more paid than the amount it came out of: asked
  s = shop(); r = owner(s, 'Patil bhau ne 1000 me se 3200 diye');
  assert.equal(r.txns.length, 0);
  // the AI path: the model takes the first number, the khata still gets the paid one
  r = await aiOwner(aiShop(model({ intent: 'jama', person: 'Patil bhau', amount: 3200 })), 'Patil bhau ne 3200 me se 1000 diye');
  assert.equal(wrote(r), 'payment 1000');
  r = await aiOwner(aiShop(model({ intent: 'jama', person: 'Meena didi', amount: 700 })), 'Meena didi ka 700 hai na? usne 200 diye');
  assert.equal(wrote(r), 'payment 200');
});

test('KAN-128: /healthz says what owner login and tax-id encryption need when they are off', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => '2026-10-20' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const j = await (await fetch('http://127.0.0.1:' + srv.address().port + '/healthz')).json();
    assert.equal(j.owner.account, false);
    assert.equal(j.owner.taxIdEncrypted, false);
    assert.match(j.owner.todo.join(' '), /ADMIN_KEY|PIN/);
    assert.match(j.owner.todo.join(' '), /TAX_ID_KEY/);
  } finally { srv.close(); }
});

test('found by the hand-checked AI run: a model that names someone not in the message, and a model that fails', async () => {
  // the model says "udhaar Pappu 200" for "Sharma ji se 200 aaya": the rules' clear jama for Sharma ji wins whole
  let r = await aiOwner(aiShop(model({ intent: 'udhaar', person: 'Pappu', amount: 200 })), 'Sharma ji se 200 aaya');
  assert.equal(wrote(r), 'payment 200'); assert.equal(r.txns[0].custId, cust(r.st, 'Sharma ji').id);
  // the model answers junk: the fallback reads with the shop's names, as the rules alone do
  const junk = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"nope":1}' } }] }) }), today: () => '2026-10-20' });
  r = await aiOwner(junk, 'Pappu toString 200');
  assert.equal(wrote(r), 'credit 200'); assert.equal(r.txns[0].custId, cust(r.st, 'Pappu').id);
});
