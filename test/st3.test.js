// Stress Test 3 (KAN-82) regressions: the corrupt-khata guard, the WhatsApp sender check, the owner key on the
// web page, and a Devanagari name finding its Latin khata (बंटी = Bunty).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const C = require('../dist-server/core/agent-core.js');
const { createFileStore } = require('../dist-server/server/store.js');
const { createServer } = require('../dist-server/server/server.js');
const { fakeWeb } = require('./fake-wa.js');

const say = (s, t) => C.handleOwnerMessage(s, t, {}).messages.filter((m) => m.to === 'owner').map((m) => m.text).join('\n');
function shopWith(names) {
  const s = C.createState({}); C.seedDemo(s, 'gupta');
  for (const n of names) { const r = say(s, n + ' ne 10 liya'); say(s, /\*naya\*/.test(r) ? 'naya' : 'haan'); }
  for (const n of names) assert.ok(s.customers.some((c) => c.name === n), 'setup ' + n);
  return s;
}
const byName = (s, n) => s.customers.find((c) => c.name === n);

// --- बंटी / Bunty
test('Devanagari बंटी finds the khata of Bunty for udhaar and jama', () => {
  const s = shopWith(['Bunty']);
  const id = byName(s, 'Bunty').id, n = s.customers.length;
  const r1 = say(s, 'बंटी ने 120 का सामान लिया');
  assert.doesNotMatch(r1, /naya|nahi mila/i);
  const r2 = say(s, 'बंटी ने 100 रुपये दिए');
  assert.doesNotMatch(r2, /nahi mila/i);
  assert.strictEqual(s.customers.length, n);
  const mine = s.txns.filter((t) => t.custId === id && !t.voided).map((t) => [t.type, t.amount]);
  assert.deepStrictEqual(mine.slice(-2), [['credit', 120], ['payment', 100]]);
});
test('बंटी asks when both Bunty and Banti have a khata, and writes nothing', () => {
  const s = shopWith(['Bunty', 'Banti']);
  const n = s.txns.length;
  const r = say(s, 'बंटी ने 120 का सामान लिया');
  assert.strictEqual(s.txns.length, n);
  assert.match(r, /Bunty|Banti|kaun|kis/i);
});
test('बंटी asks between two look-alikes Bunty and Bantey, never guesses', () => {
  const s = shopWith(['Bunty', 'Bantey']);
  const n = s.txns.length;
  say(s, 'बंटी ने 120 का सामान लिया');
  assert.strictEqual(s.txns.length, n);
});
test('Latin Banti with only Bunty asks first, never writes to Bunty', () => {
  const s = shopWith(['Bunty']);
  const n = s.txns.length;
  assert.match(say(s, 'Banti ne 50 liya'), /Bunty ka ₹50 udhaar likhna hai/);
  assert.strictEqual(s.txns.length, n);
});
test('the sound match does not join different names', () => {
  const s = shopWith(['Sonu']);
  const n = s.txns.length;
  say(s, 'Sana ne 50 liya');
  assert.ok(!s.txns.slice(n).some((t) => t.custId === byName(s, 'Sonu').id));
});

// --- KAN-85: a damaged khata file
test('a damaged khata is kept aside and load refuses, never seeding over it (KAN-85)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-st3-'));
  const st = createFileStore(dir, 'gupta');
  assert.strictEqual(st.load(), null); // no file yet: a new shop
  st.save({ hello: 1 });
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
  fs.writeFileSync(path.join(dir, f), '{"customers": [ broken');
  assert.throws(() => st.load(), /damaged/);
  assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), '{"customers": [ broken');
  const kept = fs.readdirSync(dir).filter((x) => x.includes('.corrupt-'));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"customers": [ broken');
  assert.throws(() => createServer({ env: { SHOP: 'gupta', DATA_DIR: dir }, today: () => '2026-10-08' }), /damaged/);
  assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), '{"customers": [ broken');
});

// --- KAN-91: non-mobile WhatsApp senders
test('a non-mobile WhatsApp sender gets no khata and no reply (KAN-91)', async () => {
  const sent = [];
  const web = fakeWeb((to, c) => sent.push({ to, text: c.text }));
  const env = { SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-st3wa-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: '+919800000001', PUBLIC_URL: 'https://x.example.org' };
  const server = createServer({ env, today: () => '2026-10-08', fetch: async () => new Response('{}', { status: 404 }), webTransport: web.factory });
  try {
    const n = server.getState().customers.length;
    for (const num of ['+910000000000', '+915123456789', '+9112345']) await web.inbound(server, { From: num, ProfileName: 'X', Body: 'hi' });
    assert.strictEqual(server.getState().customers.length, n);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(server.whatsapp.stats.ignored, 2); // the too-short one is dropped before it is counted
    await web.inbound(server, { From: '+919812345678', ProfileName: 'Rohit', Body: 'hi' });
    assert.ok(server.getState().customers.some((c) => c.phone === '9812345678'));
    await web.inbound(server, { From: '+919800000001', Body: 'aaj ka hisaab' });
    assert.ok(sent.some((m) => m.to === '919800000001'));
  } finally { server.close(); }
});

// --- KAN-43: the web page sends the owner key
test('the web page keeps ?key= and sends it as x-admin-key on state and act calls (KAN-43)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.src.html'), 'utf8');
  assert.match(html, /fetch\('api\/state', \{ headers: ownerHeaders\(\) \}\)/);
  assert.match(html, /fetch\('api\/act', \{ method: 'POST', headers: Object\.assign\(\{ 'content-type': 'application\/json' \}, ownerHeaders\(\)\)/);
  const src = /function ownerHeaders\(\) \{[\s\S]*?\n  \}/.exec(html)[0];
  const store = {}, replaced = [];
  const ctx = {
    URLSearchParams, location: { search: '?key=sekret', pathname: '/', hash: '#h' },
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] || null },
    history: { replaceState: (a, b, u) => replaced.push(u) }
  };
  vm.runInNewContext(src + '; out = ownerHeaders();', ctx);
  assert.strictEqual(JSON.stringify(ctx.out), JSON.stringify({ 'x-admin-key': 'sekret' }));
  assert.deepStrictEqual(replaced, ['/#h']); // the key leaves the address bar
  ctx.location.search = '';
  vm.runInNewContext(src + '; out = ownerHeaders();', ctx);
  assert.strictEqual(JSON.stringify(ctx.out), JSON.stringify({ 'x-admin-key': 'sekret' }));
  delete store['udhaar-admin-key'];
  vm.runInNewContext(src + '; out = ownerHeaders();', ctx);
  assert.strictEqual(JSON.stringify(ctx.out), JSON.stringify({}));
});

test('a customer asking in English "How much do I owe?" gets the hisaab', () => {
  const s = shopWith(['Bunty']);
  const c = s.customers.find((x) => x.name === 'Bunty');
  const r = { messages: C.handleCustomerMessage(s, c.id, 'How much do I owe?') };
  assert.match(r.messages.filter((m) => m.to === c.id).map((m) => m.text).join('\n'), /₹10 baaki/);
});
