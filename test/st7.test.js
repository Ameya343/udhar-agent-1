// Regression tests for README review 2 (KAN-142): the README's own examples must work as written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { createServer } = require('../dist-server/server/server.js');

const shop = () => C.freshShop('gupta', '2026-10-20');
function owner(s, text) {
  const m = s.messages.length, n = s.txns.length, c = s.customers.length;
  C.runAction(s, 'owner', { text });
  return { txns: s.txns.slice(n), newCust: s.customers.slice(c), reply: s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n') };
}
const supOwed = (s, name) => (s.supplies || []).filter((k) => k.name === name).reduce((a, k) => a + k.amount - (k.paid || 0), 0);

test('KAN-143: "Agrawal Traders ko 5000 dena hai" goes on the supplier khata, never a customer udhaar', () => {
  for (const [text, name] of [['Agrawal Traders ko 5000 dena hai', 'Agrawal Traders'], ['Agrawal Traders ko 5000 dene hain', 'Agrawal Traders'], ['Ramesh traders ko 5000 dena hai', 'Ramesh Traders']]) {
    const s = shop(), before = supOwed(s, name), r = owner(s, text);
    assert.equal(r.txns.length, 0, text);
    assert.equal(r.newCust.length, 0, text);
    assert.equal(supOwed(s, name), before + 5000, text);
    assert.match(r.reply, /maal udhaar/, text);
    assert.doesNotMatch(r.reply, /naya grahak/, text);
  }
  // a payment to a supplier still works, and a customer's "ko ... dena" is unchanged
  const s = shop(); owner(s, 'Agrawal Traders ko 5000 dena hai');
  assert.match(owner(s, 'Agrawal traders ko 3000 de diye').reply, /3,000 diye/);
  assert.equal(owner(shop(), 'Pappu ko 500 dena hai').newCust.length, 0);
});

test('KAN-143: the AI path, with a model that says udhaar, still writes the supplier khata', async () => {
  const reply = { lang: 'hinglish', english: '', relevant: true, intent: 'udhaar', items: [], amount: 5000, person: 'Agrawal Traders', phone: '', due_date: '', canon: '', confidence: 0.9, ask: '' };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) });
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-st7-')), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, fetch, today: () => '2026-10-20' });
  const st = srv.getState(), c = st.customers.length, before = supOwed(st, 'Agrawal Traders');
  const intent = await srv.brain.understandOwner('Agrawal Traders ko 5000 dena hai');
  C.runAction(st, 'owner', { text: 'Agrawal Traders ko 5000 dena hai', intent });
  assert.equal(st.customers.length, c);
  assert.equal(supOwed(st, 'Agrawal Traders'), before + 5000);
});

test('KAN-144: "stock: 20 kilo aata, 10 kilo cheeni, 5 tel" is a stock order, never a customer named Stock', () => {
  const s = shop(), r = owner(s, 'stock: 20 kilo aata, 10 kilo cheeni, 5 tel');
  assert.equal(r.txns.length, 0);
  assert.equal(r.newCust.length, 0);
  assert.doesNotMatch(r.reply, /naya grahak|"Stock"/);
  assert.equal(r.reply, owner(shop(), 'stock mangwa do: 20 kilo aata, 10 kilo cheeni, 5 tel').reply, 'the same as the order words');
});

test('KAN-145: a rate list saves every rate, with or without "rate list:", and the next bill uses it', () => {
  for (const text of ['aata 40 kilo, cheeni 45, Maggi 14', 'rate list: aata 40 kilo, cheeni 45, Maggi 14']) {
    const s = shop(), r = owner(s, text);
    assert.equal(r.txns.length, 0, text);
    assert.match(r.reply, /Rate yaad kar liye: Atta ₹40\/kilo, Cheeni ₹45\/kilo, Maggi ₹14/, text);
    const b = owner(s, 'Sharma ji: 2 kilo aata, 3 Maggi');
    assert.equal(b.txns[0].amount, 122, text + ': aata at ₹40 now');
  }
  const s = shop(), r = owner(s, 'rate list: aata 40, cheeni 45');
  assert.equal(r.newCust.length, 0);
  assert.match(r.reply, /Atta ₹40\/kilo, Cheeni ₹45\/kilo/);
  // quantities are never read as rates: number first, or far off the known rate
  for (const text of ['2 aata, 3 maggi', 'aata 2 kilo, maggi 3']) assert.doesNotMatch(owner(shop(), text).reply, /Rate yaad/, text);
});
