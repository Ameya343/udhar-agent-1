// Per-shop agent server: state per shop, actions, LLM via an OpenAI-compatible router, rules fallback.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, loadEnvFile } = require('../dist-server/server/server.js');

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
  assert.equal(require('../dist-server/core/agent-core.js').totalOutstanding(b2.getState()), 30530);
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

test('full loop over HTTP: reminder, cash claim, evening confirm, UPI', async () => {
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
    r = await act(u, 'galla', { text: 'Pappu 200 jama' });
    assert.equal(r.status, 400, 'the Galla Mic action is gone');
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
  assert.match(df, /RUN npx tsc -p tsconfig\.json/);
  assert.match(df, /CMD \["node", "dist-server\/server\/server\.js"\]/);
  for (const f of ['core', 'web', 'vendor', 'server', 'build.js']) assert.ok(df.includes('COPY ' + f), f);
});

test('loadEnvFile fills unset variables from a KEY=value file and never overrides real env', () => {
  const file = path.join(tmpDir(), 'udhaar.env');
  fs.writeFileSync(file, '# keys\n\nOLD_UNUSED_KEY=AC123\nexport OWNER_WHATSAPP="+91 98765 00000"\nSTT_URL=\'https://stt.example\'\nPORT=9999\nnot a line\nEMPTY_ONE=\n');
  const env = { PORT: '8000', STT_URL: '' };
  const set = loadEnvFile(file, env);
  assert.strictEqual(env.OLD_UNUSED_KEY, 'AC123');
  assert.strictEqual(env.OWNER_WHATSAPP, '+91 98765 00000');
  assert.strictEqual(env.STT_URL, 'https://stt.example');
  assert.strictEqual(env.PORT, '8000');
  assert.strictEqual(env.EMPTY_ONE, '');
  assert.deepStrictEqual(set.sort(), ['EMPTY_ONE', 'OLD_UNUSED_KEY', 'OWNER_WHATSAPP', 'STT_URL']);
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

test('a live shop (REAL_CLOCK=1): the public page is view-only (KAN-44)', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), REAL_CLOCK: '1', ADMIN_KEY: 'owner-secret' }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const post = (action, headers) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, args: action === 'owner' ? { text: 'Sharma ji ka kitna baaki hai' } : {} }) });
    const pub = { 'x-forwarded-for': '1.2.3.4' };
    for (const a of ['reset', 'nextDay', 'closeDay', 'owner', 'customer', 'confirm', 'consentAnswer']) {
      const r = await post(a, pub);
      assert.equal(r.status, 403, a);
      assert.match((await r.json()).message, /asli dukaan/);
    }
    assert.equal((await post('owner', { ...pub, 'x-admin-key': 'owner-secret' })).status, 200, 'the owner with the key can act');
    assert.equal((await post('reset', { ...pub, 'x-admin-key': 'wrong' })).status, 403);
    assert.equal((await post('reset', { ...pub, 'x-admin-key': 'owner-secret' })).status, 200);
    assert.equal((await post('reset', {})).status, 200, 'the instance itself can always reset');
  } finally { srv.close(); }
});

test('copy photo reading is gone: no /api/photo route', async () => {
  const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const u = await listen(s);
  try {
    const r = await fetch(u + '/api/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404);
    for (const a of ['copyRead', 'copyDecide', 'copyConfirmAll']) assert.equal((await act(u, a, {})).status, 400, a);
  } finally { s.close(); }
});

test('KAN-43: /api/state never sends the pay secret; a live shop shows public visitors no names, balances or entries', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), REAL_CLOCK: '1', ADMIN_KEY: 'k' }, today: () => TODAY });
  const base = await listen(srv);
  try {
    srv.getState().paySecret = 'abcdef0123456789';
    srv.getState().customers[0].phone = '9876500001';
    const pub = await (await fetch(base + '/api/state', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
    assert.equal(pub.state.paySecret, undefined);
    assert.equal(pub.locked, true);
    assert.deepEqual([pub.state.customers.length, pub.state.txns.length, pub.state.messages.length], [0, 0, 0]);
    const name = srv.getState().customers[0].name;
    assert.ok(!JSON.stringify(pub).includes('9876500001') && !JSON.stringify(pub).includes(name));
    const keyed = await (await fetch(base + '/api/state', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-admin-key': 'k' } })).json();
    assert.equal(keyed.state.customers[0].phone, '9876500001');
    const own = await (await fetch(base + '/api/state')).json();
    assert.equal(own.state.paySecret, undefined);
    assert.equal(own.state.customers[0].phone, '9876500001');
  } finally { srv.close(); }
});

test('KAN-46: a client-chosen x-forwarded-for does not escape the rate limit', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), ACT_LIMIT_PER_MIN: '2' }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const post = (xff) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ action: 'nextDay', args: {} }) }).then((r) => r.status);
    const got = [];
    for (let i = 0; i < 4; i++) got.push(await post('9.9.9.' + i + ', 1.2.3.4'));
    assert.deepEqual(got, [200, 200, 429, 429]);
  } finally { srv.close(); }
});

test('KAN-65: malformed input gets 400/404, HEAD / gets 200', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const post = (body) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.status);
    assert.equal(await post('null'), 400);
    assert.equal(await post('[1]'), 400);
    assert.equal(await post(JSON.stringify({ action: 'owner', args: { text: { toString: 1 } } })), 400);
    assert.equal((await fetch(base + '/pay/%ZZ')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
  } finally { srv.close(); }
});

test('KAN-66: pay page does not double the honorific', async () => {
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir() }, today: () => TODAY });
  const base = await listen(srv);
  try {
    const st = srv.getState(); st.paySecret = 'abcdef0123456789';
    const c = st.customers.find((x) => / ji$/.test(x.name));
    const tok = require('crypto').createHmac('sha256', st.paySecret).update(c.id).digest('hex').slice(0, 16);
    const html = await (await fetch(base + '/pay/' + c.id + '.' + tok)).text();
    assert.ok(html.includes(c.name + ', aapka baaki'), html.slice(0, 300));
    assert.ok(!html.includes(' ji ji'));
  } finally { srv.close(); }
});
