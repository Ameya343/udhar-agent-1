// Regressions from the 500-message feature stress (audit/FEATURE_STRESS_500.md): one test per reported input.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const T = '2026-10-20';
function shop() { const s = C.freshShop('gupta', T); for (const c of s.customers) if (c.phone) c.wa = true; return s; }
const run = (s, text, extra) => {
  const n = s.txns.length, m = s.messages.length;
  C.runAction(s, 'owner', Object.assign({ text, source: 'text' }, extra || {}));
  return { newT: s.txns.slice(n), owner: s.messages.slice(m).filter((x) => x.from === 'agent' && x.to === 'owner').map((x) => x.text).join('\n') };
};
const byName = (s, name) => s.customers.find((c) => c.name === name);
const one = (r, type, s, name, amount) => {
  assert.strictEqual(r.newT.length, 1, 'one entry: ' + r.owner);
  assert.strictEqual(r.newT[0].type, type, r.owner);
  assert.strictEqual(r.newT[0].custId, byName(s, name).id, r.owner);
  assert.strictEqual(r.newT[0].amount, amount, r.owner);
};

// ---- critical 1 / 3: a look-alike name is asked about, never written
for (const [msg, near, extra] of [
  ['Munna bhai ne 800 ka saman liya', 'Meena didi'],
  ['Munna bhai la do sau rupaye che saman dila', 'Meena didi', { source: 'voice' }],
  ['Kallu bhai ne 1500 ka saman liya', 'Kale madam'],
  ['Sharda tai ne 3000 ka saman liya', 'Sharma ji'],
  ['haan toh Kale bhau ka 450 likh do bhaiya', 'Kale madam', { source: 'voice' }]
]) {
  test('look-alike name asks first: ' + msg, () => {
    const s = shop();
    const r = run(s, msg, extra);
    assert.strictEqual(r.newT.length, 0, r.owner);
    assert.match(r.owner, new RegExp(near)); assert.match(r.owner, /haan/); assert.match(r.owner, /naya/);
    const r2 = run(s, 'nahi'); assert.strictEqual(r2.newT.length, 0);
  });
}
test('look-alike: haan writes to the suggested khata, naya opens a new one', () => {
  const s = shop();
  run(s, 'Munna bhai ne 800 ka saman liya');
  one(run(s, 'haan'), 'credit', s, 'Meena didi', 800);
  run(s, 'Kallu bhai ne 1500 ka saman liya');
  const r = run(s, 'naya');
  assert.strictEqual(r.newT.length, 1); assert.strictEqual(C.getCust(s, r.newT[0].custId).name, 'Kallu bhai');
});
for (const [msg, name, amt, type] of [['shrma ji ne 300 ka saman liya', 'Sharma ji', 300, 'credit'], ['vrma ji 200 udhaar likho', 'Verma ji', 200, 'credit'],
  ['sharmaji ne ₹3000 jama kiye', 'Sharma ji', 3000, 'payment'], ['वर्मा जी ने 300 जमा किए', 'Verma ji', 300, 'payment'], ['कविता आंटी ne 300 ka saman liya', 'Kavita aunty', 300, 'credit']]) {
  test('typed shorthand of a known name still writes: ' + msg, () => { const s = shop(); one(run(s, msg), type, s, name, amt); });
}

// ---- critical 2: UPI sender matched on one shared surname word
test('UPI SMS from SURESH KALE BHOSALE asks the owner', () => {
  const s = shop();
  const r = run(s, 'INR 60.00 credited to A/c XX1234 by UPI from SURESH KALE BHOSALE UPI Ref 400287871837');
  assert.strictEqual(r.newT.length, 0); assert.match(r.owner, /Kiska hai/);
});
test('UPI SMS from a known two-word name still settles', () => {
  const s = shop();
  one(run(s, 'Rs.500 received from SANJAY VERMA via UPI. Ref No 400111222333'), 'payment', s, 'Verma ji', 500);
});
// ---- low 25: VPA after the name
test('UPI SMS with a VPA after the name uses the surname', () => {
  const s = shop();
  one(run(s, 'Rs 1500 credited to your account from ANIL DESHMUKH anil@okaxis'), 'payment', s, 'Deshmukh kaka', 1500);
});

// ---- high 4: payment words
for (const [msg, name, amt] of [['iqbal ne 650 gpay kiya', 'Iqbal bhai', 650], ['Kavita aunty ka ₹3000 aa gaya', 'Kavita aunty', 3000],
  ['Gawande ji 85 phonepe kiya', 'Gawande ji', 85], ['पप्पू ne ₹120 UPI se bheje', 'Pappu', 120], ['Pappu 200 paytm kiya', 'Pappu', 200]]) {
  test('payment word is jama: ' + msg, () => { const s = shop(); one(run(s, msg), 'payment', s, name, amt); });
}
// ---- high 5: Google Pay "sent you"
test('Google Pay "sent you" SMS is a payment', () => {
  const s = shop();
  one(run(s, 'SANJAY VERMA sent you ₹150 via Google Pay. UPI txn 400123456789'), 'payment', s, 'Verma ji', 150);
});
// ---- high 6 / 8: a count is not rupees; rate memory with "name item qty unit"
test('bare count with no rate asks, never writes ₹3', () => {
  const s = shop(); s.prices = {};
  const r = run(s, 'Ansari bhai 3 Lux'); assert.strictEqual(r.newT.length, 0); assert.match(r.owner, /daam/i);
  const r2 = run(s, 'Meena didi शैम्पू 1'); assert.strictEqual(r2.newT.length, 0);
});
test('count and unit use the remembered rate', () => {
  const s = shop(); s.prices = {};
  run(s, 'Sharma ji ka bill maggi 14, besan 3 kilo 270');
  one(run(s, 'Pappu 1 maggi'), 'credit', s, 'Pappu', 14);
  one(run(s, 'Kulkarni kaku 3 maggi'), 'credit', s, 'Kulkarni kaku', 42);
  one(run(s, 'Meena didi besan 4 kilo'), 'credit', s, 'Meena didi', 360);
});
// ---- high 7: count-first bill with the name at the end
for (const [msg, name, amt] of [['4 maggi 56, besan 3 kilo 270, चावल 5 kilo 300, Parle-G 10 Thakre sir', 'Thakre sir', 636],
  ['kavita: Parle-G 10 aur tel 1 litre 180', 'Kavita aunty', 190], ['Parle-G 10, maggi 14 Pappu', 'Pappu', 24],
  ['aata 2 kilo 84 aur chawal 3 kilo 180 aur 2 Parle-G 20 vermaji', 'Verma ji', 284], ['dal 3 kilo 360 aur besan 5 kilo 450 देशमुख काका', 'Deshmukh kaka', 810]]) {
  test('bill keeps every line: ' + msg, () => {
    const s = shop(); s.prices = {};
    const r = run(s, msg); one(r, 'credit', s, name, amt);
    assert.ok(r.newT[0].lines && r.newT[0].lines.length >= 2);
  });
}
// ---- high 9: "nahi chahiye" removes from the list
test('"Krish ki list mein maggi nahi chahiye" removes maggi, no new entry', () => {
  const s = shop(); s.prices = {};
  s.customers.push({ id: 'C900', name: 'Krish', key: 'krish', phone: '9822700900', wa: true, vpas: [], dueDate: null, createdAt: T });
  const r1 = run(s, 'Krish ki list: 2 maggi 24, doodh 30, aata 2 kilo 80');
  assert.strictEqual(r1.newT[0].amount, 134);
  const r = run(s, 'Krish ki list mein maggi nahi chahiye');
  assert.strictEqual(r.newT.length, 0, r.owner);
  assert.strictEqual(s.txns.find((t) => t.id === r1.newT[0].id).amount, 110);
});
// ---- high 10: "bhej do" confirms a wholesaler draft
for (const yes of ['bhej do', 'bhejo', 'send']) {
  test('wholesaler draft goes out on "' + yes + '"', () => {
    const s = shop(); s.wholesalers.forEach((w, j) => { w.phone = '98227000' + (10 + j); w.wa = true; });
    const m0 = s.messages.length;
    run(s, 'cheeni 10 kilo, bread 20 packet mangwa do');
    assert.ok(!s.messages.slice(m0).some((m) => /^W\d/.test(m.to)));
    const m1 = s.messages.length; run(s, yes);
    const sent = s.messages.slice(m1).filter((m) => /^W\d/.test(m.to));
    assert.deepStrictEqual([...new Set(sent.map((m) => m.to))].sort(), ['W001', 'W003']);
  });
}
// ---- high 11 / 12: supplier bills and spelling variants
const supOwed = (s, nm) => (s.supplies || []).filter((x) => x.name === nm).reduce((a, x) => a + x.amount - (x.paid || 0), 0);
for (const [msg, nm, delta] of [['Hindustan agency ka 650 ka bill aaya', 'Hindustan Agency', 650], ['agarwal se 800 ka maal aaya udhaar', 'Agrawal Traders', 800],
  ['agarwal ko 1000 de diye', 'Agrawal Traders', -1000], ['agarwal se 10 bori aata 1500 udhaar', 'Agrawal Traders', 1500], ['अग्रवाल से 3000 का माल उधार', 'Agrawal Traders', 3000],
  ['agarwal ko 340 ka cheque diya', 'Agrawal Traders', -340]]) {
  test('supplier entry, never a customer: ' + msg, () => {
    const s = shop(); const b = supOwed(s, nm);
    const r = run(s, msg);
    assert.strictEqual(r.newT.length, 0, r.owner); assert.doesNotMatch(r.owner, /naya grahak/);
    assert.strictEqual(supOwed(s, nm), b + delta);
  });
}
// ---- high 13 / medium 14: spoken numbers
for (const [msg, type, name, amt] of [['Thakre sir ने साढ़े चार सौ का सामान लिया', 'credit', 'Thakre sir', 450], ['Thakre sir ने साढ़े तीन सौ रुपये दे दिए', 'payment', 'Thakre sir', 350],
  ['Verma ji ne paintalis ka saman liya', 'credit', 'Verma ji', 45], ['pappu ne pachchis ka saman liya', 'credit', 'Pappu', 25], ['wankhede ne saath ka saman liya', 'credit', 'Wankhede ji', 60],
  ['haan toh kavita ka assi likh do bhaiya', 'credit', 'Kavita aunty', 80], ['वानखेडे जी ne nabbe de diye', 'payment', 'Wankhede ji', 90], ['verma ne pachattar de diye', 'payment', 'Verma ji', 75],
  ['मीना दीदी ne pachaas de diye', 'payment', 'Meena didi', 50], ['pappu ne sau rupaye jama kiye', 'payment', 'Pappu', 100], ['कविता आंटी ने डेढ़ हज़ार रुपये दे दिए', 'payment', 'Kavita aunty', 1500],
  ['kulkarni ने डेढ़ सौ का सामान लिया', 'credit', 'Kulkarni kaku', 150], ['मीना दीदी ने नब्बे का सामान लिया', 'credit', 'Meena didi', 90], ['iqbal ने साठ का सामान लिया', 'credit', 'Iqbal bhai', 60]]) {
  test('spoken amount: ' + msg, () => { const s = shop(); one(run(s, msg, { source: 'voice' }), type, s, name, amt); });
}
test('"saath" meaning "with" is not ₹60', () => {
  const s = shop(); const r = run(s, 'Sharma ji ke saath Pappu aaye the'); assert.strictEqual(r.newT.length, 0);
});

// ---- medium 15 / 16 / 17: queries
for (const q of ['kis kis ka baaki hai', 'सबका हिसाब']) {
  test('total query: ' + q, () => {
    const s = shop(); const r = run(s, q);
    const tot = s.customers.filter((c) => !c.removed).reduce((a, c) => a + Math.max(0, C.balance(s, c.id)), 0);
    assert.match(r.owner, new RegExp(C.rupees(Math.round(tot)).replace(/[₹,]/g, '.')));
    assert.doesNotMatch(r.owner, /khata nahi mila/);
  });
}
for (const q of ['late wale kaun hai', 'kiska time nikal gaya', 'overdue list']) {
  test('late query lists the late customers: ' + q, () => {
    const s = shop(); const r = run(s, q);
    const late = s.customers.filter((c) => !c.removed && C.balance(s, c.id) > 0 && c.dueDate && c.dueDate < s.today);
    assert.ok(late.length > 0);
    for (const c of late) assert.ok(r.owner.includes(c.name), c.name + ' in ' + r.owner);
  });
}
for (const q of ['how much does Thakre sir owe', 'how much does vermaji owe', 'how much does देशमुख काका owe']) {
  test('English owe query: ' + q, () => { const s = shop(); const r = run(s, q); assert.match(r.owner, /Baaki: ₹/); assert.strictEqual(r.newT.length, 0); });
}
// ---- medium 18 / 19: corrections
test('"X ki jagah Y ka tha" moves the last entry', () => {
  const s = shop(); const a = byName(s, 'Kavita aunty'), b = byName(s, 'Kulkarni kaku');
  const ba = C.balance(s, a.id), bb = C.balance(s, b.id);
  run(s, 'Kavita aunty ne 300 ka saman liya');
  const r = run(s, 'Kavita aunty ki jagah Kulkarni kaku ka tha');
  assert.strictEqual(C.balance(s, a.id), ba); assert.strictEqual(C.balance(s, b.id), bb + 300); assert.match(r.owner, /Kulkarni kaku/);
});
test('"actually 1350 tha 1250 nahi" fixes the last entry to 1350', () => {
  const s = shop(); const p = byName(s, 'Pappu'); const b = C.balance(s, p.id);
  run(s, 'Pappu ne 1250 ka saman liya');
  const r = run(s, 'actually 1350 tha 1250 nahi');
  assert.doesNotMatch(r.owner, /naya grahak/); assert.strictEqual(C.balance(s, p.id), b + 1350);
});
// ---- medium 20 / 21: reminders
function ladderShop() {
  const s = shop(); s.txns = []; for (const c of s.customers) { c.dueDate = null; c.lastReminder = null; c.reminderLevel = 0; }
  run(s, 'Verma ji ne 500 ka saman liya kal denge'); return s;
}
test('no reminder to a customer who opted out, and the morning count does not include them', () => {
  const s = ladderShop(); const v = byName(s, 'Verma ji');
  C.runAction(s, 'customer', { custId: v.id, text: 'mujhe message mat bhejo', now: Date.UTC(2026, 9, 20, 8) });
  assert.ok(v.optedOut);
  const m0 = s.messages.length; C.runAction(s, 'nextDay', {});
  const msgs = s.messages.slice(m0);
  assert.ok(!msgs.some((m) => m.kind === 'reminder' && m.to === v.id));
  assert.ok(!msgs.some((m) => m.to === 'owner' && /reminder bheje/.test(m.text)));
});
test('a reminder that cannot go on WhatsApp is told to the owner', () => {
  const s = ladderShop(); const v = byName(s, 'Verma ji'); v.wa = false;
  const m0 = s.messages.length; C.runAction(s, 'nextDay', {});
  const owner = s.messages.slice(m0).filter((m) => m.to === 'owner').map((m) => m.text).join('\n');
  assert.match(owner, /Verma ji/); assert.match(owner, /WhatsApp reminder nahi gaya/); assert.doesNotMatch(owner, /1 reminder bheje/);
});
// ---- medium 22 / 23 / 24: customer messages
const cust = (s, id, text) => { const m0 = s.messages.length; C.runAction(s, 'customer', { custId: id, text, now: Date.UTC(2026, 9, 20, 8) }); return s.messages.slice(m0); };
test('"bhaiya 200 de diye the kal" is a payment claim, not a promise', () => {
  const s = shop(); const v = byName(s, 'Verma ji'); const due = v.dueDate;
  const msgs = cust(s, v.id, 'bhaiya 200 de diye the kal');
  assert.ok(!msgs.some((m) => /yaad dila denge/.test(m.text))); assert.strictEqual(v.dueDate, due);
  const k = (s.cashClaims || []).find((x) => x.custId === v.id && x.status === 'pending');
  assert.ok(k && k.amount === 200);
});
for (const t of ['consent cancel', 'share band karo', 'wapas le lo']) {
  test('consent revoked by text: ' + t, () => {
    const s = shop(); const v = byName(s, 'Verma ji');
    C.runAction(s, 'consentRequest', { custId: v.id }); C.runAction(s, 'consentAnswer', { custId: v.id, yes: true });
    assert.strictEqual(C.lenderView(s, v.id).shared, true);
    cust(s, v.id, t);
    assert.ok(!C.lenderView(s, v.id).shared); assert.ok(!v.optedOut);
  });
}
test('"wrong entry bhai" is a no to the entry check (dispute recorded)', () => {
  assert.strictEqual(C.shortAnswer('wrong entry bhai'), 'no');
  const s = shop(); const v = byName(s, 'Verma ji');
  const k0 = (s.cashClaims || []).length;
  run(s, 'Verma ji ne 300 ka saman liya');
  const chk = s.messages.filter((m) => m.to === v.id && m.kind === 'entry-check').pop();
  C.runAction(s, 'customerCheck', { custId: v.id, msgId: chk.id, ok: false });
  assert.ok((s.cashClaims || []).slice(k0).some((k) => k.type === 'check'));
});
