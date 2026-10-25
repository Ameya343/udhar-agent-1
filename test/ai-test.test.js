// /test-run's AI-generated cases (server/ai-test.ts), with a mocked model: the model writes the cases and reads them,
// the real pipeline runs each on a throwaway shop, and the invariants catch a wrong write without hand-written answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../dist-server/server/server.js');
const { createAiTest, numbersIn, nameIn, cleanCases, pickCases } = require('../dist-server/server/ai-test.js');
const LIVE = require('../livetest/cases.js');

const TODAY = '2026-10-20';
const ENV = { AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' };
const owner = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'unknown', items: [], amount: null, person: '', phone: '', due_date: '', confidence: 0.9 }, j);
const reply = (o) => ({ ok: true, status: 200, json: async () => ({ model: 'mock-router-model', choices: [{ message: { content: JSON.stringify(o) } }] }) });

/** A mocked model: the generator call gets `cases`; every other call (the owner reader) gets read(text). */
function model(cases, read) {
  const calls = { gen: 0, read: 0, bodies: [] };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.bodies.push(body);
    if (/You write TEST messages/.test(body.messages[0].content)) { calls.gen++; return reply({ cases }); }
    calls.read++;
    return reply(read ? read(body.messages[body.messages.length - 1].content) : { nope: true });
  };
  return { fetch, calls };
}

test('helpers: numbers and names are read from the message as typed', () => {
  assert.deepStrictEqual(numbersIn('Pappu 1,200 aur 2k, ₹300 bhi, 1.5k'), [1200, 2000, 300, 1500]);
  assert.ok(nameIn('Sharma ji', 'sharmaji ne 200 liya'));
  assert.ok(!nameIn('Sharma ji', 'ji 200 liya'), 'an honorific alone is not a name');
  assert.throws(() => cleanCases({ cases: [{ text: 'x', kind: 'nonsense' }] }, 5));
  assert.equal(cleanCases({ cases: [{ text: 'a', kind: 'credit' }, { text: 'b', kind: 'query' }, { text: 'c', kind: 'other' }] }, 2).length, 2, 'capped');
});

test('no model: the run says so and calls nothing', async () => {
  const r = await createAiTest({ env: {}, today: () => TODAY }).run(5);
  assert.equal(r.ok, false); assert.equal(r.error, 'no-model'); assert.match(r.reason, /AGENT37_LLM_PROXY_URL/);
});

test('the model writes the cases, the AI reads each one, and a right khata passes every rule', async () => {
  const cases = [
    { text: 'Pappu ne 200 ka saaman liya', kind: 'credit', name: 'Pappu', amount: 200 },
    { text: 'Meena didi ne 300 jama kiye', kind: 'payment', name: 'Meena didi', amount: 300 },
    { text: 'Verma ji ka kitna baaki hai', kind: 'query', name: 'Verma ji', amount: null }
  ];
  const read = (t) => /Pappu/.test(t) ? owner({ intent: 'udhaar', person: 'Pappu', amount: 200, canon: 'Pappu ne 200 ka saman liya' })
    : /Meena/.test(t) ? owner({ intent: 'jama', person: 'Meena didi', amount: 300, canon: 'Meena didi ne 300 jama kiye' })
    : owner({ intent: 'balance', person: 'Verma ji', canon: 'Verma ji ka kitna baaki hai' });
  const m = model(cases, read);
  const r = await createAiTest({ env: ENV, fetch: m.fetch, today: () => TODAY }).run(3);
  assert.ok(r.ok, r.reason);
  assert.equal(r.generator.via, 'Agent37 LLM router'); assert.equal(r.generator.model, 'mock-router-model');
  assert.equal(m.calls.gen, 1); assert.equal(m.calls.read, 3); assert.equal(r.calls, 4);
  assert.equal(r.aiRead, 3, 'every case was read by the model, not the rules');
  assert.deepStrictEqual(r.results.map((x) => [x.pass, x.wrote]), [[true, 'udhaar Pappu ₹200'], [true, 'jama Meena didi ₹300'], [true, 'nothing written']]);
  assert.ok(m.calls.bodies[0].temperature > 0, 'the generator is not at temperature 0, so batches differ');
});

test('a write the rules forbid is a FAIL, and a model label that disagrees is shown but not counted', async () => {
  const cases = [ // read by the rules alone (the reader answers junk)
    { text: 'Pappu ne 200 ka saaman liya', kind: 'query', name: 'Pappu', amount: 200 }, // a "question" that wrote: rule broken
    { text: 'Rohan ne 150 ka saaman liya', kind: 'credit', name: 'Rohan', amount: 999 } // right write, the label's amount is off
  ];
  const r = await createAiTest({ env: ENV, fetch: model(cases).fetch, today: () => TODAY }).run(2);
  assert.ok(r.ok);
  assert.equal(r.results[0].readBy, 'rules (AI did not answer)');
  assert.equal(r.results[0].pass, false); assert.match(r.results[0].why.join(), /query message without asking/);
  assert.equal(r.results[1].pass, true); assert.match(r.results[1].labelWhy.join(), /label says ₹999, wrote ₹150/);
  assert.equal(r.fail, 1); assert.equal(r.labelDisagree, 1);
});

test('the cap: count is clamped, and runs per hour are limited', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ text: 'Pappu ne ' + (i + 1) + ' liya', kind: 'credit', name: 'Pappu', amount: i + 1 }));
  const m = model(many);
  const t = createAiTest({ env: Object.assign({ AI_TEST_MAX_CASES: '4', AI_TEST_MAX_PER_HOUR: '2' }, ENV), fetch: m.fetch, today: () => TODAY, now: () => 1e12 });
  const a = await t.run(999);
  assert.equal(a.results.length, 4); assert.equal(a.generator.asked, 4);
  await t.run(1);
  const c = await t.run(1);
  assert.equal(c.ok, false); assert.equal(c.error, 'limit');
});

test('a generator that answers junk: a clear error, nothing run', async () => {
  const fetch = async () => reply({ hello: 'world' });
  const r = await createAiTest({ env: ENV, fetch, today: () => TODAY }).run(5);
  assert.equal(r.ok, false); assert.equal(r.error, 'generator');
});

test('POST /api/ai-test runs on throwaway shops: the shop\'s own khata is untouched', async () => {
  const m = model([{ text: 'Pappu ne 200 ka saaman liya', kind: 'credit', name: 'Pappu', amount: 200 }], () => owner({ intent: 'udhaar', person: 'Pappu', amount: 200 }));
  const srv = createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-aitest-')) }, ENV), fetch: m.fetch, today: () => TODAY });
  const before = JSON.stringify(srv.getState().txns);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const call = (method, body) => new Promise((ok, bad) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ai-test', method, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok({ code: res.statusCode, j: JSON.parse(d) }));
    });
    req.on('error', bad); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const info = await call('GET');
    assert.equal(info.j.enabled, true); assert.match(info.j.chain, /router/);
    const r = await call('POST', { count: 1 });
    assert.equal(r.code, 200); assert.ok(r.j.ok, r.j.reason); assert.equal(r.j.results[0].wrote, 'udhaar Pappu ₹200');
    assert.equal(JSON.stringify(srv.getState().txns), before, 'live khata unchanged');
    assert.equal(srv.engine.llmCalls, 0, 'the shop\'s own model stats are not mixed with the test run');
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('fixed mode: hand-checked cases with the model reading each owner message, and the rules-only result beside it', async () => {
  // a model that answers junk: every message falls back to the rules, so each result equals the rules-only one
  const junk = await createAiTest({ env: ENV, fetch: model([]).fetch, today: () => TODAY }).runFixed(12);
  assert.ok(junk.ok, junk.reason); assert.equal(junk.mode, 'fixed');
  assert.equal(junk.results.length, 12); assert.equal(junk.total, LIVE.cases.length);
  assert.equal(junk.differ, 0); assert.equal(junk.aiRead, 0);
  for (const r of junk.results) { assert.equal(r.pass, r.rulesPass); assert.ok(r.readBy.every((b) => b === 'rules')); }
  // a model that calls every message a balance question: the hand-written answers catch it, and it differs from the rules
  const bad = await createAiTest({ env: ENV, fetch: model([], () => owner({ intent: 'balance', person: 'Pappu' })).fetch, today: () => TODAY }).runFixed(40);
  assert.ok(bad.ok);
  assert.ok(bad.results.some((r) => r.readBy.includes('ai')));
  assert.ok(bad.fail > 0 && bad.differ > 0, 'a wrong model shows up as FAIL and as a difference from the rules');
  assert.ok(bad.calls >= 40);
});

test('fixed mode picks a mix of groups, only cases the owner types', () => {
  const p = pickCases(LIVE.cases, 30, 7);
  assert.equal(p.length, 30);
  assert.ok(new Set(p.map((k) => k.cat)).size >= 8, 'spread over the groups');
  assert.ok(p.every((k) => k.steps.some((s) => s.who === 'owner')));
  assert.notDeepStrictEqual(pickCases(LIVE.cases, 30, 8).map((k) => k.id), p.map((k) => k.id), 'a different mix each run');
});

test('POST /api/ai-test stream: one line per case as it finishes, nothing on the live khata, no WhatsApp send', async () => {
  const m = model([], () => owner({ intent: 'udhaar', person: 'Pappu', amount: 200 }));
  const srv = createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-aitest-')) }, ENV), fetch: m.fetch, today: () => TODAY });
  const before = JSON.stringify(srv.getState().txns), msgs = srv.getState().messages.length;
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch('http://127.0.0.1:' + srv.address().port + '/api/ai-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', count: 3, stream: true }) });
    assert.match(res.headers.get('content-type'), /ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => l.type), ['start', 'case', 'case', 'case', 'done']);
    assert.equal(lines[0].total, 3); assert.match(lines[0].chain, /router/);
    assert.ok('pass' in lines[1].result && 'rulesPass' in lines[1].result && Array.isArray(lines[1].result.readBy));
    assert.equal(lines[4].ok, true); assert.equal(lines[4].pass + lines[4].fail, 3);
    assert.equal(JSON.stringify(srv.getState().txns), before, 'live khata unchanged');
    assert.equal(srv.getState().messages.length, msgs, 'nothing queued for WhatsApp on the live shop');
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('the page has the AI section and says when there is no model', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'test-run.html'), 'utf8');
  assert.match(html, /AI-generated cases \(Agent37\)/); assert.match(html, /\/api\/ai-test/); assert.match(html, /No model on this instance/);
  assert.match(html, /Hand-checked cases on the Agent37 AI/); assert.match(html, /mode: 'fixed'/); assert.match(html, /getReader/);
});
