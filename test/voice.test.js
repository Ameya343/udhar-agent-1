// Voice notes as input: what speech-to-text hears is cleaned before the agent reads it (Devanagari to Latin
// letters, spoken amounts to digits), and the AI prompt knows the shop, the roles and every action.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core/agent-core.js');

const TODAY = '2026-10-08';

test('spoken amounts become digits: sau, hazaar, lakh, dedh, dhai, sade, sava, paune, compound and money-word anchored', () => {
  const cases = {
    'Sharma ji ke khate mein paanch sau rupaye udhaar likho': 'Sharma ji ke khate mein 500 rupaye udhaar likho',
    'Pappu ne dedh hazaar jama kiye': 'Pappu ne 1500 jama kiye',
    'dhai sau ka saman': '250 ka saman',
    'sade teen sau': '350',
    'sava sau rupaye': '125 rupaye',
    'paune do sau': '175',
    'do hazaar paanch sau': '2500',
    'teen sau pachaas': '350',
    'pandrah sau': '1500',
    'ek lakh': '100000',
    '2 hazaar': '2000',
    'pachaas rupaye de diye': '50 rupaye de diye',
    'hazaar rupaye': '1000 rupaye',
    'do sau, teen sau': '200, 300'
  };
  for (const [said, want] of Object.entries(cases)) assert.equal(C.spokenNumbers(said), want, said);
});

test('number words that are ordinary words stay words: "likh do", "ek kilo", "so jao", a plain digit', () => {
  for (const s of ['likh do', 'ek kilo cheeni', 'ab so jao', 'do kilo aata', 'Sharma ji 340', 'Verma ji ka kitna baaki hai?']) assert.equal(C.spokenNumbers(s), s, s);
  assert.equal(C.spokenNumbers('likh do paanch sau'), 'likh do 500'); // "do" is the verb, the amount is 500
  assert.equal(C.spokenNumbers('paanch sau do'), '500 do'); // "give 500", not 502
  assert.equal(C.spokenNumbers('ek hazaar do rupaye'), '1002 rupaye');
});

test('a Devanagari transcript reads as Hinglish with digits; noise tags are dropped', () => {
  assert.equal(C.cleanTranscript('शर्मा जी पाँच सौ उधार'), 'sharma ji 500 udhaar');
  assert.equal(C.cleanTranscript('डेढ़ हज़ार जमा'), '1500 jama');
  assert.equal(C.cleanTranscript('कितना बाकी है'), 'kitna baaki hai');
  assert.equal(C.cleanTranscript('[beep] (laughter) Rohit 200 udhaar'), 'Rohit 200 udhaar');
  assert.equal(C.cleanTranscript('   '), '');
});

test('cleaned voice transcripts are understood by the offline rules too (no AI needed)', () => {
  const p = (s) => C.parseOwnerMessage(C.cleanTranscript(s), TODAY);
  let r = p('शर्मा जी ने पाँच सौ का सामान लिया');
  assert.equal(r.intent, 'credit'); assert.equal(r.amount, 500); assert.equal(r.nameKey, C.parseOwnerMessage('Sharma ji 500', TODAY).nameKey);
  r = p('Pappu ne dedh hazaar jama kiye');
  assert.equal(r.intent, 'payment'); assert.equal(r.amount, 1500);
  r = p('Verma ji ne sade teen sau rupaye cash diye');
  assert.equal(r.intent, 'payment'); assert.equal(r.amount, 350);
});

test('the AI prompt knows the shop, its owner, the roles, voice noise and every action, and asks instead of guessing', () => {
  const st = C.freshShop('gupta', TODAY);
  st.shop.city = 'Nagpur';
  const p = C.llmRequestParts('Sharma ji paanch sau udhaar', st);
  for (const w of ['Gupta Kirana Store', 'Nagpur', 'Rakesh Gupta', 'SHOP OWNER', 'speech-to-text', 'dedh hazaar', 'aaj ka hisaab', 'kaun kaun baaki', 'is hafte ka hisaab', 'kisko kitna dena hai',
    'ko hatao', 'ko wapas lao', 'galti ho gayi', 'Never invent', 'ask']) assert.ok(p.system.includes(w), w);
  assert.ok(p.schema.properties.intent.enum.includes('supplier') && p.schema.properties.intent.enum.includes('week'));
  assert.deepEqual(p.schema.required, ['intent', 'name', 'items', 'amount', 'due_date', 'phone', 'canon', 'ask']);
  const cp = C.customerLlmParts(st, st.customers[0], 'kitna baaki');
  for (const w of ['Gupta Kirana Store', 'CUSTOMER', 'voice note', 'never', 'kiti baaki']) assert.ok(cp.system.includes(w), w);
});

test('AI answers: an amount the message never states is dropped; supplier and week become rule look-ups by the clean rewrite', () => {
  let i = C.intentFromLlm({ intent: 'credit', name: 'Pappu', items: '', amount: 700, due_date: '', phone: '', canon: '', ask: '' }, 'Pappu ka udhaar likho');
  assert.equal(i.amount, null);
  i = C.intentFromLlm({ intent: 'credit', name: 'Verma ji', items: 'cheeni, tel', amount: 270, due_date: '', phone: '', canon: '', ask: '' }, 'Verma ji cheeni 90, tel 180');
  assert.equal(i.amount, 270, 'the total of the prices said is allowed');
  i = C.intentFromLlm({ intent: 'payment', name: 'Pappu', items: '', amount: 150, due_date: '', phone: '', canon: '', ask: '' }, 'Pappu ne dedh sau diye');
  assert.equal(i.amount, 150);
  i = C.intentFromLlm({ intent: 'supplier', name: 'Agrawal Traders', items: '', amount: 3000, due_date: '', phone: '', canon: 'Agrawal traders ko 3000 de diye', ask: '' }, 'agrawal wale ko teen hazaar de diye');
  assert.equal(i.intent, 'unknown'); assert.equal(i.canon, 'Agrawal traders ko 3000 de diye');

  const st = C.freshShop('gupta', TODAY);
  const n = st.customers.length;
  const r = C.handleOwnerMessage(st, 'iss hafte mein kitna aayega kitna jayega', { intent: { intent: 'unknown', canon: 'is hafte ka hisaab', parser: 'llm' } });
  assert.equal(r.intent.intent, 'week');
  const s2 = C.handleOwnerMessage(st, 'Pappu ka likh do', { intent: { intent: 'credit', name: 'Pappu', nameKey: 'papu', amount: null, parser: 'llm' } });
  assert.match(s2.messages[0].text, /kitne rupaye udhaar/);
  assert.equal(st.customers.length, n);
});
