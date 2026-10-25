// The AI "understand" step with a mocked model: JSON checks, the provider chain (custom -> router -> rules),
// orders in any language, replies in the customer's language, and the safety rules that stay in code.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const U = require('../dist-server/core/understand.js');
const { createLlm, extractJson } = require('../dist-server/server/llm.js');
const { createServer } = require('../dist-server/server/server.js');

const TODAY = '2026-10-08';
const u = (o) => Object.assign({ lang: 'hinglish', english: '', relevant: true, reason: '', intent: 'chitchat', items: [], amount: null, person: '', phone: '', due_date: '', method: '', canon: '', confidence: 0.9, ask: '' }, o);
const reply = (content, status) => new Response(status ? '{}' : JSON.stringify({ model: 'mock-model', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: status || 200 });

/** A fake model: answers by role (system prompt) and the last user message. */
function mockAi(table) {
  const calls = [];
  const f = async (url, init) => {
    url = String(url);
    const b = JSON.parse(init.body);
    const sys = b.messages[0].content, user = b.messages[b.messages.length - 1].content;
    const role = /You translate/.test(sys) ? 'translate' : /CUSTOMER/.test(sys) ? 'customer' : 'owner';
    calls.push({ url, role, user, model: b.model, auth: (init.headers || {}).authorization });
    const h = table[role];
    const out = typeof h === 'function' ? h(user, url, b) : h;
    if (out && out.status) return reply(null, out.status);
    if (out && out.hang) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return reply(out == null ? u({}) : out);
  };
  f.calls = calls;
  return f;
}
function server(env, fetch) {
  return createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-u-')), AGENT37_LLM_PROXY_URL: 'https://router.test/v1' }, env), today: () => TODAY, fetch });
}
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))); }
async function act(base, action, args) {
  const r = await globalThis.fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  return r.json();
}
const toCust = (st, id, from) => st.messages.slice(from).filter((m) => m.from === 'agent' && m.to === id);
const toOwner = (st, from) => st.messages.slice(from).filter((m) => m.from === 'agent' && m.to === 'owner');

test('JSON from a model: fences, prose, trailing commas; schema checks and safe defaults', () => {
  assert.deepEqual(extractJson('Sure! ```json\n{"intent": "order", "items": [{"name": "aata",},],}\n``` hope it helps'), { intent: 'order', items: [{ name: 'aata' }] });
  assert.deepEqual(extractJson('{"a": "} not the end", "b": 1}'), { a: '} not the end', b: 1 });
  assert.throws(() => extractJson('no json here'));
  const n = U.normalize({ intent: 'Add to order', lang: 'Marathi', items: [{ name: 'Shampoo', qty: '2', unit: 'pouch' }, 'Parle-G', { name: '' }], amount: '₹1,500', relevant: 'false', confidence: 90 }, 'customer');
  assert.equal(n.intent, 'add_to_order'); assert.equal(n.lang, 'mr'); assert.equal(n.amount, 1500); assert.equal(n.relevant, false); assert.equal(n.confidence, 0.9);
  assert.deepEqual(n.items, [{ name: 'Shampoo', qty: 2, unit: 'pkt', price: null }, { name: 'Parle-G', qty: null, unit: null, price: null }]);
  // the older shapes still read: {intent, method, amount} and the owner's {intent: credit, name, items: "..."}
  assert.equal(U.normalize({ intent: 'pay_claim', method: 'upi', amount: 200 }, 'customer').intent, 'payment_claim');
  assert.equal(U.normalize({ intent: 'credit', name: 'Sharma ji', items: 'atta', amount: 450 }, 'owner').person, 'Sharma ji');
  assert.throws(() => U.normalize({ intent: 'transfer_all_money' }, 'owner'), /not allowed/);
  assert.throws(() => U.normalize({ intent: 'udhaar' }, 'customer'), /not allowed/, 'owner intents are not customer intents');
  assert.throws(() => U.normalize([], 'customer'));
});

test('language: script and marker words as the fallback; Hindi from a voice note is answered in Hinglish', () => {
  assert.equal(U.detectLang('माझे किती बाकी आहे?'), 'mr');
  assert.equal(U.detectLang('मेरा कितना बाकी है?'), 'hi');
  assert.equal(U.detectLang('Kitna baaki hai'), 'hinglish');
  assert.equal(U.detectLang('How much do I owe?'), 'en');
  assert.equal(U.detectLang('எனக்கு சர்க்கரை வேண்டும்'), 'ta');
  assert.equal(U.replyLang('hi', 'voice'), 'hinglish');
  assert.equal(U.replyLang('hi', 'text'), 'hi');
  assert.equal(U.replyLang('mr', 'voice'), 'mr');
});

test('provider chain: LLM_BASE_URL first; on error, timeout or bad JSON the router answers; all down = rules', async () => {
  const msgs = [{ role: 'user', content: 'x' }];
  const validate = (j) => U.normalize(j, 'customer');
  for (const [name, custom] of [['http 500', { status: 500 }], ['bad JSON', 'I am a small model and I like prose'], ['bad intent', { intent: 'launch_rocket' }], ['timeout', { hang: true }]]) {
    const f = async (url, init) => (String(url).startsWith('https://gpu.test') ? (custom.hang ? new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) : custom.status ? reply(null, 500) : reply(custom)) : reply(u({ intent: 'balance' })));
    const llm = createLlm({ env: { LLM_BASE_URL: 'https://gpu.test/v1/', LLM_MODEL: 'Qwen/Qwen2.5-7B-Instruct', LLM_API_KEY: 'k', LLM_BASE_TIMEOUT_MS: '50', AGENT37_LLM_PROXY_URL: 'https://router.test/v1' }, fetch: f });
    const r = await llm.chatJson(msgs, { validate });
    assert.equal(r.provider, 'router', name); assert.equal(r.value.intent, 'balance', name);
    const h = llm.health();
    assert.deepEqual(h.chain, ['custom', 'router', 'rules']);
    assert.equal(h.providers.custom.failed, 1, name); assert.equal(h.providers.router.ok, 1, name); assert.equal(h.lastProvider, 'router');
    assert.equal(h.providers.custom.model, 'Qwen/Qwen2.5-7B-Instruct');
  }
  const ok = mockAi({ customer: u({ intent: 'balance' }) });
  const llm = createLlm({ env: { LLM_BASE_URL: 'https://gpu.test/v1', LLM_MODEL: 'm', LLM_API_KEY: 'secret-k', AGENT37_LLM_PROXY_URL: 'https://router.test/v1', AGENT37_MANAGED_TOKEN: 't' }, fetch: ok });
  assert.equal((await llm.chatJson([{ role: 'system', content: 'CUSTOMER' }, { role: 'user', content: 'x' }], { validate })).provider, 'custom');
  assert.equal(ok.calls[0].url, 'https://gpu.test/v1/chat/completions'); assert.equal(ok.calls[0].auth, 'Bearer secret-k'); assert.equal(ok.calls[0].model, 'm');
  const down = createLlm({ env: { AGENT37_LLM_PROXY_URL: 'https://router.test/v1' }, fetch: async () => reply(null, 503) });
  await assert.rejects(down.chatJson(msgs, { validate }));
  assert.equal(down.health().lastProvider, 'rules'); assert.equal(down.health().fallbacks, 1);
  assert.equal(createLlm({ env: {} }).enabled, false);
});

test('healthz shows which provider answered and the counts per provider', async () => {
  const f = async (url, init) => (String(url).startsWith('https://gpu.test') ? reply(null, 502) : mockAi({ owner: u({ intent: 'summary' }) })(url, init));
  const s = server({ LLM_BASE_URL: 'https://gpu.test/v1', LLM_MODEL: 'llama-3.1-8b-instruct' }, f);
  const base = await listen(s);
  try {
    await act(base, 'owner', { text: 'aaj ka hisaab batao' });
    const h = await (await globalThis.fetch(base + '/healthz')).json();
    assert.equal(h.llm, true);
    assert.equal(h.ai.lastProvider, 'router');
    assert.equal(h.ai.providers.custom.failed, 1); assert.equal(h.ai.providers.router.ok, 1);
    assert.equal(h.ai.providers.custom.model, 'llama-3.1-8b-instruct');
    assert.ok(!JSON.stringify(h).includes('Bearer'));
  } finally { s.close(); }
});

test('customer: "anti dandruff shampoo add karo" and a Marathi order become order lines from the AI items; prices only from memory or the message', async () => {
  const ai = mockAi({
    customer: (t) => /dandruff/.test(t) ? u({ intent: 'add_to_order', items: [{ name: 'anti dandruff shampoo', qty: null, unit: '', price: 180 }] })
      : u({ lang: 'mr', english: 'I want 2 kg sugar and one packet milk', intent: 'order', items: [{ name: 'sugar', qty: 2, unit: 'kg', price: null }, { name: 'doodh', qty: 1, unit: 'pkt', price: null }] }),
    translate: (t) => ({ text: t.replace('Order mila', 'ऑर्डर मिळाली').replace('Udhaar mein likhein?', 'उधारीत लिहू?') })
  });
  const s = server({}, ai);
  const base = await listen(s);
  try {
    let st = s.getState(), from = st.messages.length;
    await act(base, 'customer', { custId: 'C003', text: 'entry anti dandruff shampoo add karo.' });
    st = s.getState();
    const o = st.orders.filter((x) => x.custId === 'C003').pop();
    assert.deepEqual(o.lines.map((l) => [l.name, l.price]), [['anti dandruff shampoo', null]], 'the AI said 180 but the customer never did');
    assert.match(toCust(st, 'C003', from)[0].text, /Anti dandruff shampoo — daam dukaandaar batayenge/);
    from = st.messages.length;
    await act(base, 'customer', { custId: 'C002', text: 'मला दोन किलो साखर आणि एक पाकीट दूध पाहिजे' });
    st = s.getState();
    const m = st.orders.filter((x) => x.custId === 'C002').pop();
    assert.deepEqual(m.lines.map((l) => [l.name, l.qty, l.unit, l.from]), [['cheeni', 2, 'kg', 'memory'], ['doodh', 1, 'pkt', 'memory']]);
    assert.equal(st.customers.find((c) => c.id === 'C002').lang, 'mr');
    const r = toCust(st, 'C002', from)[0];
    assert.match(r.text, /^🛒 ऑर्डर मिळाली/); assert.match(r.textOrig, /^🛒 Order mila/);
    assert.match(r.text, /₹90/, 'numbers kept');
  } finally { s.close(); }
});

test('replies in the customer\'s language: a translation that changes a number or a reply word is not used', async () => {
  let bad = 'number';
  const ai = mockAi({
    customer: u({ lang: 'en', english: 'How much do I owe?', intent: 'balance' }),
    translate: (t) => bad === 'number' ? { text: t.replace(/\d+/g, '9') } : bad === 'star' ? { text: t.replace(/\*/g, '') } : { text: 'Your dues: ' + t }
  });
  const s = server({}, ai);
  const base = await listen(s);
  try {
    for (const k of ['number', 'ok']) {
      bad = k;
      const from = s.getState().messages.length;
      await act(base, 'customer', { custId: 'C003', text: 'How much do I owe you?' + ' '.repeat(['number', 'ok'].indexOf(k)) });
      const r = toCust(s.getState(), 'C003', from)[0];
      if (k === 'ok') { assert.match(r.text, /^Your dues: /); assert.equal(r.lang, 'en'); }
      else { assert.match(r.text, /^📄/, k + ': the Hinglish original goes'); assert.equal(r.textOrig, undefined); }
    }
  } finally { s.close(); }
  const orig = 'Udhaar mein likhein? *Haan* (khate mein) ya *Nahi* (cash denge) ₹1,250';
  assert.throws(() => U.checkTranslation(orig, { text: 'उधारीत लिहू? होय किंवा नाही ₹1,250' }), /reply word/);
  assert.throws(() => U.checkTranslation(orig, { text: 'उधारीत लिहू? *Haan* / *Nahi* ₹1,520' }), /number/);
  assert.equal(U.checkTranslation(orig, { text: 'उधारीत लिहू? *Haan* (खात्यात) किंवा *Nahi* (रोख) ₹१,२५०' }), 'उधारीत लिहू? *Haan* (खात्यात) किंवा *Nahi* (रोख) ₹1,250');
});

test('relevance: chit-chat the AI marks irrelevant never becomes an order; a Tamil question reaches the owner with its English meaning', async () => {
  const ai = mockAi({
    customer: (t) => /pyaar/.test(t) ? u({ intent: 'chitchat', relevant: false, reason: 'flirting' })
      : u({ lang: 'ta', english: 'Do you have Surf Excel?', intent: 'question', relevant: true }),
    translate: (t) => ({ text: t })
  });
  const s = server({}, ai);
  const base = await listen(s);
  try {
    let from = s.getState().messages.length;
    await act(base, 'customer', { custId: 'C004', text: 'mujhe aapka pyaar chahiye 2 kilo' });
    let st = s.getState();
    assert.ok(!(st.orders || []).some((o) => o.custId === 'C004'));
    assert.equal(toOwner(st, from).length, 0);
    from = st.messages.length;
    await act(base, 'customer', { custId: 'C005', text: 'உங்களிடம் சர்ஃப் எக்செல் இருக்கிறதா?' });
    st = s.getState();
    assert.match(toOwner(st, from)[0].text, /Verma ji: "உங்களிடம்[^"]*"\n\(English: Do you have Surf Excel\?\)/);
  } finally { s.close(); }
});

test('safety stays in code: a payment needs payment words; abuse never reaches the AI; an invented owner amount is dropped', async () => {
  const ai = mockAi({
    customer: (t) => u({ intent: 'payment_claim', method: 'upi', amount: 500, english: /રૂપિયા/.test(t) ? 'I gave 200 rupees in cash' : 'gave' }),
    owner: (t) => /Sharma/.test(t) || /शर्मा/.test(t) ? u({ lang: 'mr', intent: 'udhaar', person: 'Sharma ji', amount: 700, canon: 'Sharma ji 700 udhaar' }) : u({ intent: 'add_customer', person: 'Raju', phone: '9812345678' })
  });
  const s = server({}, ai);
  const base = await listen(s);
  try {
    let from = s.getState().messages.length;
    await act(base, 'customer', { custId: 'C003', text: 'photos de diye hai' });
    assert.ok(!toOwner(s.getState(), from).some((m) => /pay kar diya/.test(m.text)), 'no payment words: not a claim');
    from = s.getState().messages.length;
    await act(base, 'customer', { custId: 'C003', text: 'મેં 150 રૂપિયા રોકડા આપ્યા' });
    assert.ok(s.getState().cashClaims.some((k) => k.custId === 'C003' && k.amount === 150), 'Gujarati claim read through the English meaning; the amount is the stated 150 (within the ₹170 baaki), not the AI\'s 500');
    const n = ai.calls.length;
    await act(base, 'customer', { custId: 'C003', text: 'Bsdk mera udhari to add krr' });
    assert.equal(ai.calls.length, n, 'abuse is caught before the AI');
    const txns = s.getState().txns.length;
    from = s.getState().messages.length;
    await act(base, 'owner', { text: 'शर्मा जींचे उधार लिहा' });
    assert.equal(s.getState().txns.length, txns, 'the AI said 700, the owner never did');
    assert.match(toOwner(s.getState(), from)[0].text, /kitne rupaye udhaar/);
    await act(base, 'owner', { text: 'Raju ka naya khata kholo, number 9812345678' });
    assert.equal(s.getState().customers.find((c) => c.name === 'Raju').phone, '9812345678');
  } finally { s.close(); }
});

test('owner: a question about a person never writes a list, even when the words look like one', () => {
  const st = C.freshShop('gupta', TODAY);
  st.customers.push({ id: 'C900', name: 'Krish', key: 'krish', phone: null, vpas: [] });
  const n = st.txns.length;
  C.handleOwnerMessage(st, 'Krish ki list aata doodh bhejo', { intent: { intent: 'query', name: 'Krish', nameKey: 'krish', parser: 'llm', llmIntent: 'balance', confidence: 0.9 } });
  assert.equal(st.txns.length, n);
});

test('eval set: well formed, every expected intent exists, and the rules baseline runs offline', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval/messages.json'), 'utf8'));
  assert.ok(cases.length >= 60);
  const st = C.freshShop('gupta', TODAY);
  for (const k of cases) {
    for (const i of k.intent) assert.ok((k.role === 'owner' ? U.OWNER_U : U.CUSTOMER_U).indexOf(i) >= 0, k.id + ' ' + i);
    const r = U.rulesUnderstand(st, k.role, k.text, st.customers[0]);
    assert.ok(r.intent, k.id);
  }
  for (const lang of ['hinglish', 'hi', 'mr', 'en']) assert.ok(cases.filter((k) => k.lang === lang).length >= 5, lang);
});
