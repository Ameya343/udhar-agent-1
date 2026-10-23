// Per-shop agent server: state per shop, actions, LLM via an OpenAI-compatible router, rules fallback.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, loadEnvFile } = require('../server/server.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-')); }
async function act(base, action, args) {
  const r = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  return { status: r.status, body: await r.json() };
}
// A stand-in for the Agent37 LLM router: answers /chat/completions with a fixed JSON reply.
function fakeLlm(reply, opts) {
  opts = opts || {};
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
      if (opts.status) { res.writeHead(opts.status); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }));
    });
  });
  srv.seen = seen;
  return srv;
}

test('each shop gets its own khata, saved to its own file', async () => {
  const dir = tmpDir();
  const a = createServer({ env: { SHOP: 'gupta', DATA_DIR: dir }, today: () => TODAY });
  const b = createServer({ env: { SHOP: 'balaji', DATA_DIR: dir }, today: () => TODAY });
  const [ua, ub] = [await listen(a), await listen(b)];
  try {
    const sa = await (await fetch(ua + '/api/state')).json();
    const sb = await (await fetch(ub + '/api/state')).json();
    assert.equal(sa.state.shop.name, 'Gupta Kirana Store');
    assert.equal(sb.state.shop.name, 'Balaji Dairy & General');
    assert.equal(sb.dashboard.outstanding, 30370);
    assert.deepEqual(sb.dashboard.overdue.map((o) => o.name).slice(0, 2), ['Suresh driver', 'Mishra ji']);
    assert.equal(sa.engine.llm, false);

    const r = await act(ub, 'owner', { text: 'Anita bhabhi ne 2 litre doodh aur paneer liya 160 ka, kal denge', source: 'voice', dur: 5 });
    assert.equal(r.status, 200);
    assert.ok(r.body.freshTxn);
    assert.equal(r.body.dashboard.outstanding, 30530);
    assert.ok(fs.existsSync(path.join(dir, 'gupta.json')) && fs.existsSync(path.join(dir, 'balaji.json')));
    const sa2 = await (await fetch(ua + '/api/state')).json();
    assert.equal(sa2.dashboard.outstanding, sa.dashboard.outstanding, 'the other shop is untouched');
  } finally { a.close(); b.close(); }
  // a restart reads the saved khata back
  const b2 = createServer({ env: { SHOP: 'balaji', DATA_DIR: dir }, today: () => TODAY });
  assert.equal(require('../core/agent-core.js').totalOutstanding(b2.getState()), 30530);
});

test('page is served with the shop config; health check answers', async () => {
  const s = createServer({ env: { SHOP: 'balaji', DATA_DIR: tmpDir(), OTHER_SHOPS: 'Gupta Kirana|https://gupta.example.com,bad|javascript:alert(1)' }, today: () => TODAY });
  const u = await listen(s);
  try {
    const html = await (await fetch(u + '/')).text();
    assert.match(html, /window\.UDHAAR_SERVER=\{"shopId":"balaji","others":\[\{"name":"Gupta Kirana","url":"https:\/\/gupta\.example\.com"\}\]\}/);
    assert.doesNotMatch(html, /javascript:alert/);
    const h = await (await fetch(u + '/healthz')).json();
    assert.equal(h.ok, true); assert.equal(h.shop, 'balaji'); assert.equal(h.llm, false);
    assert.equal((await fetch(u + '/nope')).status, 404);
  } finally { s.close(); }
});

test('full loop over HTTP: reminder, cash claim, evening confirm, Galla Mic, UPI', async () => {
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const u = await listen(s);
  try {
    await act(u, 'owner', { text: 'Sharma ji ne 340 ka saaman liya, kal denge', source: 'voice' });
    let r = await act(u, 'nextDay');
    assert.ok(r.body.result.some((m) => m.kind === 'reminder' && m.to === 'C001'));
    r = await act(u, 'customer', { custId: 'C001', text: 'Cash de diya' });
    assert.equal(r.body.dashboard.pendingCount, 1);
    r = await act(u, 'closeDay');
    const claim = r.body.state.cashClaims.find((k) => k.status === 'pending');
    r = await act(u, 'confirm', { claimId: claim.id, ok: true });
    assert.equal(r.body.dashboard.pendingCount, 0);
    assert.ok(!r.body.state.customers.find((c) => c.id === 'C001').dueDate || r.body.state.txns.some((t) => t.custId === 'C001' && t.type === 'payment' && t.date === r.body.state.today));
    r = await act(u, 'galla', { text: 'Aaj garmi bahut hai' });
    assert.equal(r.body.result.action, 'ignored');
    assert.ok(!JSON.stringify(r.body.state).includes('garmi'), 'chatter is not stored');
    r = await act(u, 'upi', { text: 'Rs 700.00 received from MEENA KUMARI via Google Pay. UPI Ref 551200987654' });
    assert.ok(r.body.freshTxn);
    r = await act(u, 'reset');
    assert.equal(r.body.state.txns.filter((t) => t.note !== 'seed').length, 0);
  } finally { s.close(); }
});

test('bad requests are refused and do not touch the khata', async () => {
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const u = await listen(s);
  try {
    const before = JSON.stringify(s.getState());
    assert.equal((await act(u, 'deleteEverything', {})).status, 400);
    assert.equal((await act(u, 'customer', { custId: 'C999', text: 'hi' })).status, 400);
    assert.equal((await act(u, 'owner', { text: '' })).status, 400);
    assert.equal((await fetch(u + '/api/act', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(u + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(u + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'owner', args: { text: 'x'.repeat(20000) } }) })).status, 413);
    // an intent sent by the browser is ignored: the server decides what the words mean
    const r = await act(u, 'owner', { text: 'Aaj ka hisaab batao', intent: { intent: 'credit', name: 'Hacker', amount: 99999, parser: 'llm' } });
    assert.equal(r.status, 200);
    assert.ok(!r.body.state.customers.some((c) => c.name === 'Hacker'));
    assert.equal(JSON.parse(before).txns.length, r.body.state.txns.length);
  } finally { s.close(); }
});

test('LLM via the Agent37 router: token, model and reply are used', async () => {
  const llm = fakeLlm({ intent: 'credit', name: 'Sharma ji', items: 'atta', amount: 450, due_date: '2026-10-10', phone: '' });
  const lu = await listen(llm);
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: lu + '/llm/v1/', AGENT37_MANAGED_TOKEN: 'test-token', LLM_MODEL: 'default' }, today: () => TODAY });
  const u = await listen(s);
  try {
    const r = await act(u, 'owner', { text: 'sharma ji ka chaar sau pachaas likh do atta ka, shanivar', source: 'voice' });
    const t = r.body.state.txns.find((x) => x.id === r.body.freshTxn);
    assert.equal(t.amount, 450); assert.equal(t.custId, 'C001'); assert.equal(t.parser, 'llm'); assert.equal(t.dueDate, '2026-10-10');
    assert.equal(llm.seen[0].url, '/llm/v1/chat/completions');
    assert.equal(llm.seen[0].auth, 'Bearer test-token');
    assert.equal(llm.seen[0].body.model, 'default');
    assert.ok(r.body.state.messages.some((m) => m.to === 'owner' && m.parser === 'llm'));
    assert.equal(r.body.engine.llm, true); assert.equal(r.body.engine.lastError, null);
  } finally { s.close(); llm.close(); }
});

test('LLM down, slow or nonsense: the offline rules answer instead', async () => {
  for (const [name, llm, env] of [
    ['http 500', fakeLlm(null, { status: 500 }), {}],
    ['not JSON', fakeLlm('sorry, I cannot help'), {}],
    ['bad intent', fakeLlm({ intent: 'transfer_all_money', name: '', items: '', amount: 0, due_date: '', phone: '' }), {}],
    ['timeout', http.createServer(() => {}), { LLM_TIMEOUT_MS: '200' }]
  ]) {
    const lu = await listen(llm);
    const s = createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: lu }, env), today: () => TODAY });
    const u = await listen(s);
    try {
      const r = await act(u, 'owner', { text: 'Sharma ji ne 340 ka saaman liya, kal denge' });
      const t = r.body.state.txns.find((x) => x.id === r.body.freshTxn);
      assert.ok(t, name + ': entry written');
      assert.equal(t.amount, 340, name); assert.equal(t.parser, 'rules', name);
      assert.ok(r.body.engine.lastError, name + ': error reported');
    } finally { s.close(); llm.closeAllConnections && llm.closeAllConnections(); llm.close(); }
  }
});

test('real-clock scheduler: a new day sends reminders by itself, and the evening summary goes once', async () => {
  let day = TODAY, hour = 9;
  const s = createServer({ env: { SHOP: 'balaji', DATA_DIR: tmpDir() }, today: () => day, hour: () => hour });
  assert.deepEqual(await s.tick(), []);
  day = '2026-10-09';
  assert.deepEqual(await s.tick(), ['nextDay']);
  const st = s.getState();
  assert.equal(st.today, '2026-10-09');
  assert.ok(st.messages.some((m) => m.kind === 'reminder' && m.to === 'C003'));
  hour = 21;
  assert.deepEqual(await s.tick(), ['closeDay']);
  assert.deepEqual(await s.tick(), []);
  // after the demo jumps ahead, the real date never pulls the khata back
  s.getState().today = '2026-10-12';
  assert.deepEqual(await s.tick(), []);
  assert.equal(s.getState().today, '2026-10-12');
});

test('consent over HTTP: ask, customer says yes, then takes it back', async () => {
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const u = await listen(s);
  try {
    let r = await act(u, 'consentRequest', { custId: 'C001' });
    assert.equal(r.body.state.consents.C001.status, 'requested');
    r = await act(u, 'consentAnswer', { custId: 'C001', yes: true });
    assert.equal(r.body.state.consents.C001.status, 'granted');
    r = await act(u, 'consentRevoke', { custId: 'C001' });
    assert.equal(r.body.state.consents.C001.status, 'revoked');
  } finally { s.close(); }
});

test('the Dockerfile builds the page and serves port 8000', () => {
  const df = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.match(df, /RUN node build\.js/);
  assert.match(df, /EXPOSE 8000/);
  assert.match(df, /REAL_CLOCK=1/);
  assert.match(df, /DATA_DIR=\/home\/node\/data/, 'khata lives on the persistent mount');
  assert.match(df, /CMD \["node", "server\/server\.js"\]/);
  for (const f of ['core', 'web', 'vendor', 'server', 'build.js']) assert.ok(df.includes('COPY ' + f), f);
});

test('copy photo over HTTP: the server asks its own AI, proposes lines, writes only after ✅; no AI says so', async () => {
  const reading = { format: 'daily_list', page_date: TODAY, language: 'hindi', customer: '', lines: [{ name: 'Sharma ji', amount: 240, type: 'credit', date: '', items: 'atta', raw: 'शर्मा 240', sure: true }] };
  const llm = fakeLlm(reading);
  const lu = await listen(llm);
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: lu }, today: () => TODAY });
  const u = await listen(s);
  const img = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64');
  const photo = (body) => fetch(u + '/api/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const n = s.getState().txns.length;
    let r = await photo({ image: img, mode: 'daily' });
    assert.equal(r.status, 200);
    const j = await r.json();
    const sent = llm.seen[0].body.messages[0].content;
    assert.equal(sent[1].type, 'image_url'); assert.equal(sent[1].image_url.url, img);
    assert.match(sent[0].text, /handwritten udhaar/);
    assert.equal(j.state.txns.length, n, 'nothing written yet');
    const rv = j.state.copyReviews[0];
    assert.equal(rv.lines[0].status, 'new');
    assert.ok(!JSON.stringify(j.state).includes('fake jpeg'), 'the photo is not stored');
    r = await act(u, 'copyConfirmAll', { reviewId: rv.id });
    assert.equal(r.body.state.txns.length, n + 1);
    // a reading pushed by the browser is refused
    assert.equal((await act(u, 'copyRead', { reading })).status, 400);
    assert.equal((await photo({ image: 'data:text/html;base64,PGI+', mode: 'daily' })).status, 400);
  } finally { s.close(); llm.close(); }
  const s2 = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const u2 = await listen(s2);
  try {
    const r = await fetch(u2 + '/api/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: img }) });
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'no_ai' });
  } finally { s2.close(); }
});

test('loadEnvFile fills unset variables from a KEY=value file and never overrides real env', () => {
  const file = path.join(tmpDir(), 'udhaar.env');
  fs.writeFileSync(file, '# keys\n\nTWILIO_ACCOUNT_SID=AC123\nexport OWNER_WHATSAPP="+91 98765 00000"\nSTT_URL=\'https://stt.example\'\nPORT=9999\nnot a line\nEMPTY_ONE=\n');
  const env = { PORT: '8000', STT_URL: '' };
  const set = loadEnvFile(file, env);
  assert.strictEqual(env.TWILIO_ACCOUNT_SID, 'AC123');
  assert.strictEqual(env.OWNER_WHATSAPP, '+91 98765 00000');
  assert.strictEqual(env.STT_URL, 'https://stt.example');
  assert.strictEqual(env.PORT, '8000');
  assert.strictEqual(env.EMPTY_ONE, '');
  assert.deepStrictEqual(set.sort(), ['EMPTY_ONE', 'OWNER_WHATSAPP', 'STT_URL', 'TWILIO_ACCOUNT_SID']);
  assert.deepStrictEqual(loadEnvFile(path.join(tmpDir(), 'missing.env'), {}), []);
});

test('public visitors are rate limited on /api/act; local calls are not', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), ACT_LIMIT_PER_MIN: '2' }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const post = (ip) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify({ action: 'nextDay', args: {} }) }).then((r) => r.status);
    assert.deepEqual([await post('1.2.3.4'), await post('1.2.3.4'), await post('1.2.3.4')], [200, 200, 429]);
    assert.equal(await post('5.6.7.8'), 200, 'another visitor has its own budget');
    assert.deepEqual([await post(), await post(), await post()], [200, 200, 200], 'local calls are not limited');
  } finally { srv.close(); }
});

test('a live shop (REAL_CLOCK=1): a public visitor cannot reset the khata or move its day', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), REAL_CLOCK: '1', ADMIN_KEY: 'owner-secret' }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const post = (action, headers) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, args: action === 'owner' ? { text: 'Sharma ji ka kitna baaki hai' } : {} }) });
    const pub = { 'x-forwarded-for': '1.2.3.4' };
    for (const a of ['reset', 'nextDay', 'closeDay']) {
      const r = await post(a, pub);
      assert.equal(r.status, 403, a);
      assert.match((await r.json()).message, /asli dukaan/);
    }
    assert.equal((await post('owner', pub)).status, 200, 'everything else stays open');
    assert.equal((await post('reset', { ...pub, 'x-admin-key': 'wrong' })).status, 403);
    assert.equal((await post('reset', { ...pub, 'x-admin-key': 'owner-secret' })).status, 200);
    assert.equal((await post('reset', {})).status, 200, 'the instance itself can always reset');
  } finally { srv.close(); }
});
