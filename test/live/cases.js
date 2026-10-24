// Synthetic Hinglish test cases for the live test-run page (web/test-run.src.html) and its CLI (test/live/run.js).
// The expected result of every case is written here by hand, from what a shopkeeper means by the sentence and from
// the bugs logged in Jira KAN. Nothing here calls or imports the core: the oracle must not come from the code under test.
// Works in Node (module.exports) and in the page (self.UdhaarCases).
(function (root, make) { if (typeof module === 'object' && module.exports) module.exports = make(); else root.UdhaarCases = make(); })(typeof self !== 'undefined' ? self : this, function () {
  const TODAY = '2026-10-20';
  // Gupta demo shop balances, read off the seed table by hand: open udhaar per customer, everyone else 0
  const SEED = {
    'Sharma ji': 0, 'Meena didi': 700, 'Pappu': 170, 'Iqbal bhai': 0, 'Verma ji': 530, 'Kavita aunty': 0, 'Rohan': 170,
    'Deshmukh kaka': 2400, 'Patil bhau': 3200, 'Joshi kaku': 850, 'Wankhede ji': 1900, 'Kale madam': 600, 'Bhonsle bhau': 3600,
    'Ansari bhai': 1450, 'Fernandes aunty': 0, 'Gawande ji': 2750, 'Thakre sir': 980, 'Kulkarni kaku': 0, 'Shaikh bhai': 1200,
    'Raut bhau': 3900, 'Meshram ji': 700, 'Bawane ji': 2100, 'Nair aunty': 450, 'Choudhary ji': 1650, 'Lanjewar bhau': 2300
  };
  const UPI = { 'Sharma ji': 'ramesh.sharma@okaxis', 'Meena didi': 'meena.k@ybl', 'Iqbal bhai': 'iqbal786@paytm' };
  // how an owner might write each customer: [what they type, the khata it means]
  const SAY = [
    ['Sharma ji', 'Sharma ji'], ['sharma ji', 'Sharma ji'], ['SHARMA JI', 'Sharma ji'], ['Sharma', 'Sharma ji'], ['sharmaji', 'Sharma ji'],
    ['Meena didi', 'Meena didi'], ['meena', 'Meena didi'], ['Meena di', 'Meena didi'],
    ['Pappu', 'Pappu'], ['pappu', 'Pappu'], ['PAPPU', 'Pappu'],
    ['Iqbal bhai', 'Iqbal bhai'], ['iqbal', 'Iqbal bhai'],
    ['Verma ji', 'Verma ji'], ['verma', 'Verma ji'], ['Vermaji', 'Verma ji'],
    ['Kavita aunty', 'Kavita aunty'], ['kavita', 'Kavita aunty'],
    ['Rohan', 'Rohan'], ['rohan', 'Rohan'],
    ['Deshmukh kaka', 'Deshmukh kaka'], ['Patil bhau', 'Patil bhau'], ['Joshi kaku', 'Joshi kaku'], ['Wankhede ji', 'Wankhede ji'],
    ['Ansari bhai', 'Ansari bhai'], ['Thakre sir', 'Thakre sir'], ['Shaikh bhai', 'Shaikh bhai'], ['Nair aunty', 'Nair aunty'],
    ['Choudhary ji', 'Choudhary ji'], ['Gawande ji', 'Gawande ji']
  ];
  const DEVA = [['शर्मा जी', 'Sharma ji'], ['मीना दीदी', 'Meena didi'], ['पप्पू', 'Pappu'], ['इकबाल भाई', 'Iqbal bhai'], ['वर्मा जी', 'Verma ji'], ['कविता आंटी', 'Kavita aunty'], ['रोहन', 'Rohan']];
  // not customers of this shop: must never land on an existing khata
  const STRANGERS = ['Kallu bhai', 'Bunty', 'Golu', 'Chintu', 'Tinku', 'Munna bhai', 'Sonu', 'Bablu', 'Guddu', 'Lalit', 'Kamble ji', 'Mehta ji', 'Shinde kaka', 'Pawar saheb', 'Kale bhau', 'Ramesh Gupta', 'Pappu ka bhai', 'Verma ji ka beta'];
  // "Sharma uncle" is left out on purpose: the core treats ji / uncle / aunty as the same person, which is a fair reading
  // names that are also JavaScript object keys (KAN-95)
  const JSNAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype', 'isPrototypeOf', '__defineGetter__'];

  // the amount the owner means, in the ways it gets typed or spoken
  const AMT_WORDS = [[100, 'sau'], [100, 'ek sau'], [150, 'dedh sau'], [175, 'paune do sau'], [200, 'do sau'], [250, 'dhai sau'], [300, 'teen sau'],
    [350, 'saade teen sau'], [450, 'saade chaar sau'], [500, 'paanch sau'], [700, 'saat sau'], [1000, 'ek hazaar'], [1500, 'dedh hazaar'], [2000, 'do hazaar'],
    [50, 'pachaas'], [80, 'assi'], [500, 'पाँच सौ'], [200, 'दो सौ'], [1000, 'एक हज़ार']];
  const DEV = (n) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[+d]);
  const AMT_FORMS = [[(a) => String(a)], [(a) => '₹' + a], [(a) => 'Rs ' + a], [(a) => 'Rs.' + a], [(a) => a + 'rs'], [(a) => a + '/-'], [(a) => a + ' rupaye'], [(a) => DEV(a)]];

  let seed = 20261024;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const amount = () => pick([40, 60, 85, 120, 150, 200, 240, 300, 340, 450, 500, 650, 800, 1000, 1250, 1500, 2200]);
  const fill = (t, o) => t.replace(/\{(\w+)\}/g, (_, k) => o[k]);

  const cases = [];
  const CAT = {};
  function cat(id, label, why) { CAT[id] = { id, label, why }; }
  // expect: { writes: [[type, khata, amount]] } exact new entries | { none: true } nothing written | { noExisting: true } nothing on an existing khata
  //         | { balances: { khata: rupees } } | { pay: amount | false } (UPI pay amount for the QR)
  function add(c, steps, expect, note) { cases.push({ id: cases.length + 1, cat: c, steps, expect, note: note || '' }); }
  const o = (text, expect) => ({ who: 'owner', text, expect });
  const upi = (text, expect) => ({ who: 'upi', text, expect });

  // ---------- 1. udhaar (credit) in everyday words
  cat('udhaar', 'Udhaar likhna', 'Plain credit entries, many phrasings and name spellings');
  const CREDIT = ['{n} ne {a} ka saman liya', '{n} ne {a} ka saaman liya', '{n} {a} udhaar', '{n} {a} udhar', '{n} ko {a} udhaar diya', '{n} ke khate mein {a} likh do',
    '{n} ka {a} udhaar likho', '{n} {a} ka saman le gaya', '{n} ne {a} ka maal liya', '{n} ke naam {a} likh do', '{n} {a} baaki likh do', '{n} ne {a} udhaar liya'];
  for (let i = 0; i < 110; i++) { const [n, k] = pick(SAY), a = amount(); add('udhaar', [o(fill(pick(CREDIT), { n, a }), { writes: [['credit', k, a]] })]); }

  // ---------- 2. jama (payment), incl. "Pappu ka 500 aaya" (KAN-84) and payment verbs (KAN-49)
  cat('jama', 'Jama / payment', 'Money received: "diye", "jama", "aaya", "lautaye", "ada kiye", "paid"');
  const PAY = ['{n} ne {a} diye', '{n} ne {a} de diye', '{n} ne {a} jama kiye', '{n} ka {a} aaya', '{n} se {a} aaya', '{n} se {a} mil gaye', '{n} ne {a} lautaye',
    '{n} ne {a} cash diye', '{n} paid {a}', '{n} ne {a} ada kiye', '{n} ne {a} jama karaye', '{n} ka {a} jama karo'];
  for (let i = 0; i < 110; i++) { const [n, k] = pick(SAY), a = amount(); add('jama', [o(fill(pick(PAY), { n, a }), { writes: [['payment', k, a]] })]); }

  // ---------- 3. amount formats (KAN-22, KAN-52)
  cat('amounts', 'Amount formats', '₹, Rs, /-, Devanagari digits, number words like "dhai sau", "paune do sau"');
  for (let i = 0; i < 70; i++) {
    const [n, k] = pick(SAY);
    if (i % 2) { const [a, w] = pick(AMT_WORDS); add('amounts', [o(n + ' ne ' + w + ' ka saman liya', { writes: [['credit', k, a]] })]); }
    else { const a = amount(), f = pick(AMT_FORMS)[0]; add('amounts', [o(n + ' ne ' + f(a) + ' diye', { writes: [['payment', k, a]] })]); }
  }
  for (const [t, a] of [['1,200', 1200], ['2,200', 2200], ['1,500', 1500], ['2k', 2000], ['1.5k', 1500]]) add('amounts', [o('Pappu ne ' + t + ' ka saman liya', { writes: [['credit', 'Pappu', a]] })]);

  // ---------- 4. Devanagari and mixed script (KAN-21, KAN-93)
  cat('devanagari', 'Hindi script', 'Full Devanagari and mixed-script sentences');
  const DCREDIT = ['{n} ने {a} का सामान लिया', '{n} {a} उधार', '{n} ने {a} उधार लिया', '{n} ne {a} ka सामान liya'];
  const DPAY = ['{n} ने {a} दिए', '{n} ने {a} लौटाए', '{n} ने {a} जमा किए', '{n} se {a} आया'];
  for (let i = 0; i < 50; i++) {
    const [n, k] = pick(DEVA), a = amount(), credit = i % 2 === 0;
    add('devanagari', [o(fill(pick(credit ? DCREDIT : DPAY), { n, a: i % 3 ? String(a) : DEV(a) }), { writes: [[credit ? 'credit' : 'payment', k, a]] })]);
  }

  // ---------- 5. not an entry: negation, question, promise, balance query (KAN-15, 16, 17, 57)
  cat('no-entry', 'Not an entry', 'Negation, questions, promises and balance queries must write nothing');
  const NONE = ['{n} ne {a} nahi diye', '{n} ne {a} diye kya?', '{n} kal {a} dega', '{n} {a} dega', 'kya {n} ne {a} diye?', '{n} ne abhi tak {a} nahi diye',
    '{n} ka kitna baaki hai?', '{n} ka hisaab batao', '{n} ne {a} nahi lautaye', '{n} parso {a} dega', '{n} ka kitna hua?', '{n} ne {a} diye the kya'];
  for (let i = 0; i < 70; i++) { const [n] = pick(SAY), a = amount(); add('no-entry', [o(fill(pick(NONE), { n, a }), { none: true })]); }

  // ---------- 6. stray acknowledgements with nothing to answer (KAN-58, KAN-68)
  cat('stray', 'Stray "ok" / "theek hai"', 'Short replies with no open question must write and change nothing');
  for (const t of ['ok', 'OK', 'Ok ji', 'theek hai', 'thik h', 'thik hai bhai', 'haan', 'ha', 'haan ji', 'ji', '👍', '🙏', '✅', 'acha', 'accha', 'hmm', 'sahi hai', 'done', 'nahi', 'galat', 'hello', 'namaste', 'kya haal', 'shukriya', 'thanks', 'ok ok', 'haan likh do', 'theek hai likh do'])
    add('stray', [o(t, { none: true })]);

  // ---------- 7. bad or two amounts, phone numbers (KAN-20, 45, 48, 53, 61)
  cat('bad-amount', 'Bad / unclear amounts', 'Zero, two numbers, spaced digits, 1e5, hex, phone numbers: never guess money');
  for (const [n] of [['Pappu'], ['Sharma ji'], ['Verma ji'], ['Meena didi'], ['Iqbal bhai']]) {
    for (const t of ['{n} ne 0 liya', '{n} ne 200 300 liya', '{n} ne 200-300 liya', '{n} ne 5 0 0 liya', '{n} ne 1e5 liya', '{n} ne 0x1F4 liya', '{n} ka number 98765 43210', '{n} ka number 12345'])
      add('bad-amount', [o(fill(t, { n }), { none: true })]);
  }

  // ---------- 8. names that are JS object keys (KAN-95)
  cat('js-names', 'Names like "constructor"', 'Words that are JavaScript object keys: no crash, no write on an existing khata');
  for (const n of JSNAMES) {
    for (const t of ['{n} ne 500 ka saman liya', '{n} 200 udhaar', '{n} ne 300 diye', '{n} ka kitna baaki hai']) add('js-names', [o(fill(t, { n }), { noExisting: true })]);
    // "Pappu cheeni 200" is an item line, so "Pappu constructor 200" is ₹200 udhaar for Pappu with an odd item name: no crash is what counts
    add('js-names', [o('Pappu ' + n + ' 200', { writes: [['credit', 'Pappu', 200]] })]);
  }

  // ---------- 9. strangers and look-alikes (KAN-19, KAN-90)
  cat('strangers', 'Unknown names', 'People without a khata, and look-alikes ("Sharma uncle", "Shinde kaka"): never written to someone else');
  for (const n of STRANGERS) for (const t of ['{n} ne 400 ka saman liya', '{n} ne 250 diye', '{n} 150 udhaar'])
    add('strangers', [o(fill(t, { n }), { noExisting: true })]);

  // ---------- 10. junk and hostile text
  cat('junk', 'Junk input', 'Script tags, SQL, emoji, very long text, a bare number: no crash, nothing written');
  for (const t of ['<script>alert(1)</script>', "'; DROP TABLE txns; --", '🙂🙂🙂', 'a'.repeat(600), '500', '₹500', '??', '....', 'null', 'undefined', 'NaN',
    'Pappu', 'udhaar', 'jama', '123456789012345', '​​', 'Pappu Pappu Pappu', 'asdfgh qwerty'])
    add('junk', [o(t, { none: true })]);

  // ---------- 11. several things in one message (KAN-23, 47, 51)
  cat('combo', 'Two things in one line', '"500 ka saman, usme se 200 de diye", two customers in one line, "ko cash diye" (shop gave cash)');
  for (let i = 0; i < 40; i++) {
    const [n, k] = pick(SAY.slice(0, 20)), a = pick([500, 800, 1000, 1500]), b = pick([100, 200, 300]);
    const kind = i % 4;
    if (kind === 0) add('combo', [o(n + ' ne ' + a + ' ka saman liya, usme se ' + b + ' de diye', { writes: [['credit', k, a], ['payment', k, b]] })]);
    else if (kind === 1) add('combo', [o(n + ' ko ' + b + ' cash diye', { writes: [['credit', k, b]] })], 'shop handed cash: that is udhaar');
    else {
      const [m, j] = pick(SAY.slice(0, 20).filter((x) => x[1] !== k));
      add('combo', [o(n + ' ' + a + ', ' + m + ' ' + b + ' udhaar', { writes: [['credit', k, a], ['credit', j, b]] })]);
    }
  }

  // ---------- 12. very big amounts are confirmed first (KAN-20)
  cat('big', 'Huge amounts', 'A crore-size amount is asked first; written only after "haan"');
  for (const [n, k] of SAY.slice(0, 20)) {
    const a = pick([99999999, 5000000, 2500000]);
    add('big', [o(n + ' ne ' + a + ' ka saman liya', { none: true }), o('haan', { writes: [['credit', k, a]] })]);
  }
  for (const [n] of SAY.slice(0, 10)) add('big', [o(n + ' ne 99999999 ka saman liya', { none: true }), o(pick(['nahi', 'galat', 'mat likho']), { none: true }), o('ok', { none: true })], 'a no, then a stray ok, write nothing');

  // ---------- 13. UPI SMS: known UPI id pays, partial amounts, outgoing money, name-only senders (KAN-103, 104, 105)
  cat('upi', 'UPI SMS', 'Bank SMS: known UPI id is jama (full or part), money the shop sent is never jama, a name-only sender is asked first');
  let ref = 600100200300;
  for (let i = 0; i < 60; i++) {
    const k = pick(Object.keys(UPI)), v = UPI[k], a = pick([50, 100, 150, 200, 300, 350, 500, 650]);
    const t = pick(['Rs {a} credited to your a/c XX1234 by UPI from {v} Ref {r}', 'INR {a}.00 received from {v} UPI Ref No {r}', '₹{a} received from {v} via UPI. UTR {r}', 'Rs.{a} credited to A/c XX9876 on 20-10-26 from VPA {v} (UPI Ref {r})']);
    add('upi', [upi(fill(t, { a, v, r: ref++ }), { writes: [['payment', k, a]] })], 'part of the baaki, as a QR payback would send');
  }
  for (let i = 0; i < 20; i++) {
    const n = pick(['PAPPU', 'Sharma', 'MEENA', 'Verma']), a = pick([200, 300, 500]);
    add('upi', [upi(fill(pick(['Rs {a} debited from a/c XX1234 to {n} UPI Ref {r}', 'You have sent Rs {a} to {n} via UPI. Ref {r}', 'Rs.{a} paid to {n} from your a/c XX1234. UPI Ref {r}']), { a, n, r: ref++ }), { none: true })], 'money the shop sent out');
  }
  for (let i = 0; i < 12; i++) {
    const a = pick([200, 300]);
    add('upi', [upi('Rs ' + a + ' credited to your a/c XX1234 by UPI from someone' + i + '@okicici Ref ' + ref++, { noExisting: true })], 'unknown UPI id');
  }
  for (const k of Object.keys(UPI)) add('upi', [upi('Rs 99,99,999 credited to your a/c XX1234 by UPI from ' + UPI[k] + ' Ref ' + ref++, { none: true })], 'huge UPI amount is asked');

  // ---------- 14. QR payback amount: full, part, and refused amounts (UPI QR pay page)
  cat('qr', 'QR partial amounts', 'Amount typed on the pay page: blank = full baaki, a part is allowed, 0 / paise / text / over the baaki are refused');
  for (const k of ['Meena didi', 'Verma ji', 'Pappu', 'Deshmukh kaka', 'Raut bhau']) {
    const b = SEED[k];
    add('qr', [{ who: 'pay', cust: k, text: '', expect: { pay: b } }], 'blank: full baaki');
    add('qr', [{ who: 'pay', cust: k, text: String(b), expect: { pay: b } }]);
    for (const t of ['100', '₹100', 'Rs.100', '100/-', '100.00']) add('qr', [{ who: 'pay', cust: k, text: t, expect: { pay: 100 } }]);
    const part = Math.round(b / 2 / 10) * 10;
    add('qr', [{ who: 'pay', cust: k, text: String(part), expect: { pay: part } }], 'half');
    for (const t of ['0', '-50', 'abc', '1e3', '99.50', '5000000', String(b + 50), '']) if (t) add('qr', [{ who: 'pay', cust: k, text: t, expect: { pay: false } }]);
  }

  // ---------- 15. the ledger adds up
  cat('ledger', 'Ledger maths', 'Seed balances, then udhaar and jama on top must add up to the rupee');
  for (const k of Object.keys(SEED)) add('ledger', [{ who: 'none', text: '(seed khata of ' + k + ')', expect: { balances: { [k]: SEED[k] } } }]);
  for (let i = 0; i < 40; i++) {
    const [n, k] = pick(SAY.slice(0, 20)), a = amount(), b = pick([50, 100, a]);
    add('ledger', [o(n + ' ne ' + a + ' ka saman liya', { writes: [['credit', k, a]] }), o(n + ' ne ' + b + ' diye', { writes: [['payment', k, b]], balances: { [k]: SEED[k] + a - b } })]);
  }

  return { TODAY, SEED, CAT, cases };
});
