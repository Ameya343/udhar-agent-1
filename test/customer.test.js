// Customer messages are understood, not pattern-matched: an LLM classifies each one (strict rules when it is down).
// Emoji, jokes and random text never become payment claims or owner pings; opt-out and abuse are handled quietly;
// a repeated payment claim is not a new claim. The messages below are the real ones from the live shop on 18 Oct.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const C = require('../core/agent-core.js');
const { createServer } = require('../server/server.js');
const { twilioSignature } = require('../server/whatsapp.js');

const TODAY = '2026-10-18';
const T0 = Date.UTC(2026, 9, 18, 6, 0, 0);
const MIN = 60 * 1000, HOUR = 60 * MIN;
const KRISH = ['😂😂😂😂', '😂😂😂😂😂😂😂😂😂', 'Seth dekh', 'Dekhna abb', 'Old is gold', 'Aur kya puch skta hu gupta  ji se'];
const FAKE_PAY = ['Nudes de diya', 'Rand de diya hai', 'Gaand de diya hai', 'Aaand de diya hai', 'Abe ye kuch nhi samjhra....usse bss "one-word" de diya hai.....to accept krr lera hai'];
const PUSHPANSH_OPT_OUT = 'Nhi chahiye gupta kirana se kuch bhi mujhe';
const PUSHPANSH_ABUSE = '"Maa chuda"';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function shopWith(name, phone) {
  const s = C.freshShop('gupta', TODAY);
  const c = C.customerFromWhatsapp(s, phone, name).cust;
  return { s, c };
}
function say(s, c, text, at, intent) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: at, intent });
  const got = s.messages.slice(n).filter((m) => m.from === 'agent');
  return { toCust: got.filter((m) => m.to === c.id), toOwner: got.filter((m) => m.to === 'owner') };
}

test('rules: the exact emoji, jokes and random text are never a payment claim and never ping the owner', () => {
  const { s, c } = shopWith('Krish Singh', '9022099109');
  delete c.guest;
  C.runAction(s, 'owner', { text: 'krish ne 200 ka saman liya' });
  let menus = 0;
  for (const [i, t] of KRISH.concat(FAKE_PAY.filter((x) => !C.customerPrefilter(x) || C.customerPrefilter(x).intent !== 'abusive')).entries()) {
    const r = say(s, c, t, T0 + i * MIN);
    assert.strictEqual(r.toOwner.length, 0, 'no owner ping for ' + t);
    assert.ok(!r.toCust.some((m) => /Payment aate hi|cash note/.test(m.text)), 'no claim reply for ' + t);
    menus += r.toCust.length;
  }
  assert.strictEqual(menus, 1, 'at most one short friendly reply in half an hour');
  assert.strictEqual(C.pendingCash(s, c.id), 0);
  for (const t of KRISH.concat(FAKE_PAY)) assert.notStrictEqual(C.customerIntentRules(s, c, t).intent, 'pay_claim', t);
  assert.strictEqual(C.customerIntentRules(s, c, 'Old is gold').intent, 'chitchat');
  assert.strictEqual(C.customerIntentRules(s, c, '😂😂😂😂').intent, 'chitchat');
});

test('rules: real payment words still make a claim ("maine 200 de diye", "Upi de diya", "cash de diya")', () => {
  const { s, c } = shopWith('Krish Singh', '9022099109');
  delete c.guest;
  C.runAction(s, 'owner', { text: 'krish ne 500 ka saman liya' });
  for (const t of ['maine 200 de diye', 'Upi de diya', 'paid', '200 bhej diye', 'मैंने 200 दे दिए', 'payment kar diya', 'jama kar diya']) assert.strictEqual(C.customerIntentRules(s, c, t).intent, 'pay_claim', t);
  for (const t of ['kal dunga', 'Friday ko de dunga', 'I\'ll pay via only fans', 'Gupta ji pe mera 5000 rupaye udhar hai']) assert.notStrictEqual(C.customerIntentRules(s, c, t).intent, 'pay_claim', t);
  const r = say(s, c, 'maine 200 de diye', T0);
  assert.match(r.toCust[0].text, /Payment aate hi khata update/);
  assert.strictEqual(r.toOwner.length, 1);
  assert.match(r.toOwner[0].text, /Krish Singh keh rahe hain unhone ₹200 pay kar diya/);
  const k = say(s, c, 'cash de diya', T0 + MIN);
  assert.match(k.toCust[0].text, /₹500 cash note kar liya/);
  assert.strictEqual(C.pendingCash(s, c.id), 500);
});

test('claim dedupe: the same customer cannot stack claims or re-ping the owner within 6 hours', () => {
  const { s, c } = shopWith('Krish Singh', '9022099109');
  delete c.guest;
  C.runAction(s, 'owner', { text: 'krish ne 200 ka saman liya' });
  say(s, c, 'cash de diya', T0);
  for (let i = 1; i <= 4; i++) {
    const r = say(s, c, 'cash de diya', T0 + i * MIN);
    assert.match(r.toCust[0].text, /cash wala message dukaandaar ke paas hai/);
    assert.strictEqual(r.toOwner.length, 0);
  }
  assert.strictEqual(C.pendingClaims(s).filter((k) => k.custId === c.id).length, 1, 'one pending cash claim');
  // UPI: one owner ping per 6 hours
  const pings = [];
  for (let i = 0; i < 5; i++) pings.push(...say(s, c, 'UPI kar diya', T0 + i * MIN).toOwner);
  assert.strictEqual(pings.length, 1);
  assert.strictEqual(say(s, c, 'UPI kar diya', T0 + 7 * HOUR).toOwner.length, 1, 'a claim after 6 hours is told again');
});

test('opt-out: "Nhi chahiye ..." stops all messages, one polite confirmation, no raw relay to the owner', () => {
  const { s, c } = shopWith('Pushpansh Tayal', '7020498571');
  assert.ok(s.ownerAsks.some((a) => a.custId === c.id), 'the "Naya number" question was pending');
  const r = say(s, c, PUSHPANSH_OPT_OUT, T0);
  assert.ok(c.optedOut);
  assert.strictEqual(r.toCust.length, 1); assert.strictEqual(r.toCust[0].kind, 'optout-ack');
  assert.match(r.toCust[0].text, /message nahi aayenge/);
  assert.strictEqual(r.toOwner.length, 1);
  assert.match(r.toOwner[0].text, /Pushpansh Tayal ne WhatsApp messages band karwa diye/);
  assert.doesNotMatch(r.toOwner[0].text, /gupta kirana se/i, 'not the raw chat');
  assert.ok(!s.ownerAsks.some((a) => a.custId === c.id), 'the owner is no longer asked about this number');
  for (const t of ['hello?', '😂', 'Old is gold', PUSHPANSH_OPT_OUT]) { const x = say(s, c, t, T0 + 5 * MIN); assert.strictEqual(x.toCust.length + x.toOwner.length, 0, t); }
  for (const t of ['band karo', 'stop', 'message mat bhejo', 'nahi chahiye']) assert.strictEqual(C.customerPrefilter(t).intent, 'opt_out', t);
  for (const t of ['aata nahi chahiye, sirf cheeni 1 kilo', 'kal mat bhejo saman, parso bhejna']) assert.ok(!C.customerPrefilter(t), t);
  // writing "start" turns messages back on
  const back = say(s, c, 'start', T0 + HOUR);
  assert.ok(!c.optedOut); assert.match(back.toCust[0].text, /Phir se swagat/);
});

test('abuse: no reply, no raw text to the owner, one short rate-limited owner note', () => {
  const { s, c } = shopWith('Pushpansh Tayal', '7020498571');
  const first = say(s, c, PUSHPANSH_ABUSE, T0);
  assert.strictEqual(first.toCust.length, 0, 'no reply loop');
  assert.strictEqual(first.toOwner.length, 1);
  assert.strictEqual(first.toOwner[0].text, '🚫 Pushpansh Tayal ne bekaar message bheja, ignore kiya.');
  for (const t of ['Bsdk mera udhari to add krr', 'Aree mc', 'Gaand de diya hai', 'Lund de diya hai', 'Nudes de diya', 'I\'ll pay via only fans']) {
    const r = say(s, c, t, T0 + MIN);
    assert.strictEqual(r.toCust.length + r.toOwner.length, 0, t);
    assert.strictEqual(C.customerPrefilter(t).intent, 'abusive', t);
  }
  assert.strictEqual(say(s, c, PUSHPANSH_ABUSE, T0 + 7 * HOUR).toOwner.length, 1, 'the note may come again after 6 hours');
  assert.strictEqual(C.pendingCash(s, c.id), 0);
  for (const t of ['chhut milegi kya?', 'chura 1 kilo', 'chod do, rehne do']) assert.ok(!C.customerPrefilter(t), 'not abuse: ' + t);
});

test('every real message for the shopkeeper reaches the owner (the same text twice in half an hour only once); never a menu', () => {
  const { s, c } = shopWith('Krish Singh', '9022099109');
  const a = say(s, c, 'Gupta ji pe mera 5000 rupaye udhar hai', T0);
  assert.strictEqual(a.toOwner.length, 1);
  assert.match(a.toOwner[0].text, /Krish Singh: "Gupta ji pe mera 5000 rupaye udhar hai"/);
  assert.doesNotMatch(a.toCust[0].text, /Aap aise likh sakte/);
  assert.match(a.toCust[0].text, /dukaan ko bhej diya/);
  assert.strictEqual(say(s, c, 'Gupta ji pe mera 5000 rupaye udhar hai', T0 + 5 * MIN).toOwner.length, 0, 'same text repeated');
  const d = say(s, c, 'meri entry galat likhi hai', T0 + 10 * MIN);
  assert.strictEqual(d.toOwner.length, 1, 'a dispute (rules) always reaches the owner');
  assert.match(d.toCust[0].text, /Aapki baat dukaan ko bhej di/);
});

test('LLM intent (mocked): chit-chat stays quiet, "maine 200 de diye" is a claim, a "pay_claim" without payment words is not', () => {
  const { s, c } = shopWith('Krish Singh', '9022099109');
  delete c.guest;
  C.runAction(s, 'owner', { text: 'krish ne 300 ka saman liya' });
  const llm = (j, text) => C.customerIntentFromLlm(j, text);
  let r = say(s, c, 'Old is gold', T0, llm({ intent: 'chitchat', method: '', amount: 0 }, 'Old is gold'));
  assert.strictEqual(r.toOwner.length, 0);
  r = say(s, c, 'Old is gold', T0 + MIN, llm({ intent: 'pay_claim', method: 'upi', amount: 0 }, 'Old is gold'));
  assert.strictEqual(r.toOwner.length, 1, 'downgraded to a question for the shopkeeper');
  assert.doesNotMatch(r.toOwner[0].text, /pay kar diya/);
  assert.strictEqual(llm({ intent: 'pay_claim', method: 'upi', amount: 0 }, 'Rand de diya hai').intent, 'abusive');
  r = say(s, c, 'maine 200 de diye', T0 + 2 * MIN, llm({ intent: 'pay_claim', method: 'upi', amount: 200 }, 'maine 200 de diye'));
  assert.match(r.toOwner[0].text, /keh rahe hain unhone ₹200 pay kar diya/);
  r = say(s, c, 'bhaiya hisaab bhejo', T0 + 3 * MIN, llm({ intent: 'balance', method: '', amount: 0 }, 'bhaiya hisaab bhejo'));
  assert.strictEqual(r.toCust[0].kind, 'statement');
  assert.strictEqual(llm({ intent: 'transfer_all', method: '', amount: 0 }, 'x'), null, 'unknown intent: rules decide');
});

// ---------------------------------------------------------------- end to end: WhatsApp (Twilio) + a mocked LLM
const PUBLIC = 'https://gupta.example.org', OWNER = '+919800000001', KRISH_NO = '+919022099109', PUSH_NO = '+917020498571';
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
// what the real model says for the 18 Oct chatter (relevant=false); anything relevant now always reaches the owner
const LLM_SAYS = { 'Old is gold': 'chitchat', 'Seth dekh': 'chitchat', 'Dekhna abb': 'chitchat', 'Aur kya puch skta hu gupta  ji se': 'chitchat', 'Aaand de diya hai': 'chitchat',
  'Abe ye kuch nhi samjhra....usse bss "one-word" de diya hai.....to accept krr lera hai': 'chitchat', 'maine 200 de diye': 'pay_claim', 'Nudes de diya': 'pay_claim', 'Kitna baaki hai': 'balance', 'hi': 'greeting' };
function fakeNet(llmDown) {
  const sent = [], llmCalls = [];
  const f = async (url, init) => {
    url = String(url);
    if (url.endsWith('/chat/completions')) {
      const b = JSON.parse(init.body); const user = b.messages[b.messages.length - 1].content;
      llmCalls.push(user);
      if (llmDown) return new Response('{}', { status: 503 });
      const isCustomer = /CUSTOMER/.test(b.messages[0].content);
      const content = isCustomer ? { intent: LLM_SAYS[user] || 'question', method: LLM_SAYS[user] === 'pay_claim' ? 'upi' : '', amount: /200/.test(user) ? 200 : 0 } : { intent: 'unknown', name: '', items: '', amount: 0, due_date: '', phone: '' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    }
    if (url.includes('/Messages.json')) { const p = new URLSearchParams(init.body); sent.push({ to: p.get('To').replace('whatsapp:', ''), body: p.get('Body') }); return new Response('{}', { status: 201 }); }
    return new Response('{}', { status: 404 });
  };
  f.sent = sent; f.llmCalls = llmCalls;
  f.to = (n) => sent.filter((x) => x.to === n).map((x) => x.body);
  return f;
}
async function inbound(base, server, fields) {
  const params = Object.assign({ MessageSid: 'SM' + Math.random().toString(16).slice(2), NumMedia: '0' }, fields);
  const sig = twilioSignature('secret-token', PUBLIC + '/whatsapp', params);
  await fetch(base + '/whatsapp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params).toString() });
  await server.idle();
}

for (const llmDown of [false, true]) {
  test('WhatsApp end to end, LLM ' + (llmDown ? 'down (rules)' : 'up (mocked)') + ': the 18 Oct conversation, replayed', async () => {
    const net = fakeNet(llmDown);
    const server = createServer({ env: { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-cust-')), TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886', OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC, AGENT37_LLM_PROXY_URL: 'https://llm.example.org/v1' }, today: () => TODAY, fetch: net });
    const base = await listen(server);
    try {
      await inbound(base, server, { From: 'whatsapp:' + KRISH_NO, ProfileName: 'Krish Singh', Body: 'hi' });
      await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'ok' });
      await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'krish ne 200 ka saman liya' });
      await inbound(base, server, { From: 'whatsapp:' + KRISH_NO, Body: 'Haan' });
      const ownerBefore = net.to(OWNER).length;
      for (const t of KRISH.concat(FAKE_PAY, ['Lund de diya hai', 'Chut de diya hai'])) await inbound(base, server, { From: 'whatsapp:' + KRISH_NO, Body: t });
      const ownerNow = net.to(OWNER).slice(ownerBefore);
      assert.ok(!ownerNow.some((b) => /pay kar diya/.test(b)), 'no false payment claims: ' + ownerNow.join(' | '));
      assert.ok(!ownerNow.some((b) => /Old is gold|😂|Nudes|Lund/.test(b)), 'no raw chit-chat or abuse relayed');
      assert.ok(ownerNow.length <= 1, 'at most the one "bekaar message" note: ' + ownerNow.join(' | '));
      assert.ok(!net.llmCalls.some((u) => /😂|Lund|Chut|Nudes|Rand|Gaand/.test(u)), 'emoji and abuse never reach the LLM');
      // a real claim still works, once
      await inbound(base, server, { From: 'whatsapp:' + KRISH_NO, Body: 'maine 200 de diye' });
      await inbound(base, server, { From: 'whatsapp:' + KRISH_NO, Body: 'maine 200 de diye' });
      assert.strictEqual(net.to(OWNER).filter((b) => /Krish Singh keh rahe hain unhone ₹200 pay kar diya/.test(b)).length, 1);
      // the new number: opt-out, then abuse; nothing raw reaches the owner and nothing more goes to the number
      await inbound(base, server, { From: 'whatsapp:' + PUSH_NO, ProfileName: 'Pushpansh Tayal', Body: 'hi' });
      const pushBefore = net.to(PUSH_NO).length, ownerMid = net.to(OWNER).length;
      await inbound(base, server, { From: 'whatsapp:' + PUSH_NO, Body: PUSHPANSH_OPT_OUT });
      await inbound(base, server, { From: 'whatsapp:' + PUSH_NO, Body: PUSHPANSH_ABUSE });
      await inbound(base, server, { From: 'whatsapp:' + PUSH_NO, Body: 'Old is gold' });
      const toPush = net.to(PUSH_NO).slice(pushBefore), toOwner = net.to(OWNER).slice(ownerMid);
      assert.strictEqual(toPush.length, 1); assert.match(toPush[0], /message nahi aayenge/);
      assert.ok(!toOwner.some((b) => /gupta kirana se|Maa chuda|Old is gold/i.test(b)), toOwner.join(' | '));
      assert.ok(toOwner.some((b) => /band karwa diye/.test(b)));
      const st = server.getState();
      assert.ok(st.customers.find((x) => x.phone === '7020498571').optedOut);
      // owner commands, haan/galat and remove/restore are untouched
      await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'Krish ko hatao' });
      assert.ok(server.getState().customers.find((x) => x.phone === '9022099109').removed);
      await inbound(base, server, { From: 'whatsapp:' + OWNER, Body: 'Krish ko wapas lao' });
      assert.ok(!server.getState().customers.find((x) => x.phone === '9022099109').removed);
      if (!llmDown) assert.ok(net.llmCalls.includes('Old is gold'), 'the LLM classified the customer message');
    } finally { server.close(); }
  });
}
