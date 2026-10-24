// The AI reads every owner message and decides the route; the rules only check its answer, read answers to the
// agent's own questions and bank SMS, and take over when the model fails or times out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-brain-'));

/** A shop whose model answers with `reply` (an object, or a function of the call count); calls are counted. */
function shop(reply, env) {
  const calls = { n: 0 };
  const fetch = async () => {
    const r = typeof reply === 'function' ? reply(calls.n++) : (calls.n++, reply);
    if (r && r.http) return { ok: false, status: r.http, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(r) } }] }) };
  };
  const srv = createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, env || {}), fetch, today: () => TODAY });
  return Object.assign(srv, { calls });
}
const owner = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'unknown', items: [], amount: null, person: '', phone: '', due_date: '', confidence: 0.9 }, j);
async function say(srv, text) {
  const st = srv.getState();
  const txns = st.txns.length, msgs = st.messages.length;
  const a = { text };
  a.intent = await srv.brain.understandOwner(text);
  const out = C.runAction(st, 'owner', a);
  return { intent: a.intent, newTxns: st.txns.slice(txns), toCustomers: st.messages.slice(msgs).filter((m) => m.from === 'agent' && m.to !== 'owner'), out, state: st };
}

test('every owner message goes to the AI, the counter and bare-number messages too', async () => {
  for (const text of ['Pappu ne 200 ka saaman liya', 'chhotu 2 kilo aata tol do', '5', 'ok']) {
    const srv = shop(owner({ intent: 'chitchat' }));
    await say(srv, text);
    assert.equal(srv.calls.n, 1, text + ': one AI call');
  }
});

test('the AI decides: chitchat never becomes a removal, a counter bill, a list edit or a stock order', async () => {
  for (const text of ['Pappu ko hata do', 'chhotu 2 kilo aata tol do', 'Pappu ki list mein 2 Maggi jod do', 'Agrawal Traders se 10 kilo aata mangwao', 'ok', 'theek hai']) {
    const srv = shop(owner({ intent: 'chitchat' }));
    const r = await say(srv, text);
    assert.equal(r.newTxns.length, 0, text + ': nothing written');
    assert.equal(r.toCustomers.length, 0, text + ': nobody messaged');
    assert.ok(!r.state.customers.find((c) => c.name === 'Pappu').removed, text + ': Pappu stays');
    assert.ok(!r.state.pending || r.state.pending.type !== 'counter', text + ': no counter bill');
    assert.ok(!(r.state.wsOrders || []).length, text + ': no stock order');
  }
});

test('the AI\'s money still needs the owner\'s words: name and amount must be in the message', async () => {
  let r = await say(shop(owner({ intent: 'udhaar', person: 'Pappu', amount: 500 })), 'ok');
  assert.equal(r.newTxns.length, 0);
  r = await say(shop(owner({ intent: 'udhaar', person: 'Pappu', amount: 500 })), 'Pappu ne 500 ka saaman liya');
  assert.equal(r.newTxns.length, 1);
  assert.equal(r.newTxns[0].amount, 500);
  assert.equal(r.intent.parser, 'llm');
});

test('an answer to the agent\'s own question keeps its exact parser and costs no AI call', async () => {
  const srv = shop(owner({ intent: 'udhaar', person: 'Pappu', amount: 900 }));
  srv.getState().pending = { type: 'confirm', what: 'new-cust', options: [], action: { intent: 'credit', name: 'Ramesh', nameKey: 'ramesh', amount: 200, raw: 'Ramesh ne 200 liya' } };
  const before = srv.calls.n;
  const r = await say(srv, 'haan');
  assert.equal(srv.calls.n, before, 'no AI call for "haan"');
  assert.notEqual(r.intent.parser, 'llm');
});

test('the rules take over when the AI fails or times out', async () => {
  let r = await say(shop({ http: 500 }), 'Pappu ne 200 ka saaman liya');
  assert.equal(r.newTxns.length, 1);
  assert.equal(r.newTxns[0].type, 'credit');
  assert.notEqual(r.intent.parser, 'llm');
  // a model that never answers: the router's timeout, then the rules
  const hang = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1', LLM_TIMEOUT_MS: '200' }, today: () => TODAY,
    fetch: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  const t0 = Date.now();
  r = await say(hang, 'Meena didi ne 300 diye');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.newTxns.length, 1);
  assert.equal(r.newTxns[0].type, 'payment');
});

test('KAN-107: the AI\'s rewrite never writes a list the owner did not say', async () => {
  const canon = owner({ intent: 'list', person: 'Pappu', canon: 'Pappu ki list: aata 80, cheeni 40' });
  for (const text of ['Pappu aaya tha', 'Pappu aaya tha aaj']) {
    const r = await say(shop(canon), text);
    assert.equal(r.newTxns.length, 0, text + ': nothing written');
  }
  // only aata was said: the AI's cheeni is never written (aata at the shop's rate, as the rules alone write it)
  let r = await say(shop(canon), 'Pappu aaya tha, aata le gaya');
  assert.ok(r.newTxns.every((t) => !/cheeni/.test(t.items || '') && !(t.lines || []).some((l) => /cheeni/i.test(l.name))));
  // every item in the owner's own words: the list is read (prices only from the owner's words or the shop's rates)
  r = await say(shop(canon), 'Pappu aaya tha, aata aur cheeni le gaya');
  assert.ok(r.newTxns.every((t) => t.custId === r.state.customers.find((c) => c.name === 'Pappu').id));
});
