// Feature stress: >=500 generated messages per feature through the compiled core (npm run build first). Run: node test/stress/s500.js
const C = require(require('path').join(__dirname, '..', '..', 'dist-server', 'core', 'agent-core.js'));
const TODAY = '2026-10-20';
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const R = (n) => Math.round(n);

// ---------------- names
const KNOWN = {
  C001: ['Sharma ji', 'sharma', 'sharmaji', 'शर्मा जी', 'Sharma g', 'shrma ji', 'SHARMA JI'],
  C002: ['Meena didi', 'meena', 'मीना दीदी', 'meena di'],
  C003: ['Pappu', 'pappu', 'पप्पू'],
  C004: ['Iqbal bhai', 'iqbal', 'इकबाल भाई'],
  C005: ['Verma ji', 'verma', 'वर्मा जी', 'vermaji', 'vrma ji'],
  C006: ['Kavita aunty', 'kavita', 'कविता आंटी'],
  C008: ['Deshmukh kaka', 'deshmukh', 'देशमुख काका'],
  C009: ['Patil bhau', 'patil', 'पाटील भाऊ'],
  C011: ['Wankhede ji', 'wankhede', 'वानखेडे जी'],
  C014: ['Ansari bhai', 'ansari'],
  C016: ['Gawande ji', 'gawande', 'गावंडे जी'],
  C018: ['Kulkarni kaku', 'kulkarni'],
  C017: ['Thakre sir', 'thakre'],
};
const KIDS = Object.keys(KNOWN);
// people who are NOT customers: must never be written to an existing khata
const UNKNOWN = ['Kallu bhai', 'Bunty', 'Golu', 'Chintu', 'Tinku', 'Munna bhai', 'Sonu', 'Bablu', 'Guddu', 'Lalit', 'Kamble ji', 'Wakode ji', 'Kalpana tai', 'Raju', 'Shinde kaka', 'Mehta ji', 'Sharda tai', 'Vaishali', 'Pawar saheb', 'Kale bhau'];

// ---------------- amounts
const NUMW = [[50, 'pachaas', 'पचास'], [60, 'saath', 'साठ'], [75, 'pachattar', 'पचहत्तर'], [80, 'assi', 'अस्सी'], [90, 'nabbe', 'नब्बे'], [100, 'sau', 'सौ'], [100, 'ek sau', 'एक सौ'], [120, 'ek sau bees', 'एक सौ बीस'], [150, 'dedh sau', 'डेढ़ सौ'], [200, 'do sau', 'दो सौ'], [250, 'dhai sau', 'ढाई सौ'], [300, 'teen sau', 'तीन सौ'], [340, 'teen sau chalis', 'तीन सौ चालीस'], [350, 'saade teen sau', 'साढ़े तीन सौ'], [450, 'saade chaar sau', 'साढ़े चार सौ'], [500, 'paanch sau', 'पाँच सौ'], [700, 'saat sau', 'सात सौ'], [1000, 'ek hazaar', 'एक हज़ार'], [1200, 'barah sau', 'बारह सौ'], [1500, 'dedh hazaar', 'डेढ़ हज़ार'], [2000, 'do hazaar', 'दो हज़ार'], [25, 'pachchis', 'पच्चीस'], [45, 'paintalis', 'पैंतालीस'], [5000, 'paanch hazaar', 'पाँच हज़ार']];
const DEV = (n) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[d]);
function amt() {
  const a = pick([40, 60, 85, 120, 150, 200, 240, 300, 340, 450, 500, 650, 800, 1000, 1250, 1500, 2200, 3000]);
  const f = pick(['d', 'd', 'd', 'rs', 'r', 'comma', 'dev']);
  const s = f === 'rs' ? 'Rs ' + a : f === 'r' ? '₹' + a : f === 'comma' && a >= 1000 ? a.toLocaleString('en-IN') : f === 'dev' ? DEV(a) : String(a);
  return [a, s];
}

// ---------------- harness
const fails = new Map(); const stats = {}; const ALL = {};
function fail(feat, sev, key, input, actual, expected) {
  const k = feat + '|' + key;
  const f = fails.get(k) || { feat, sev, key, n: 0, input, actual, expected };
  f.n++; fails.set(k, f); return false;
}
function shop() {
  const s = C.freshShop('gupta', TODAY);
  for (const c of s.customers) if (c.phone) c.wa = true;
  return s;
}
const cust = (s, id) => C.getCust(s, id);
const isWs = (to) => /^W\d/.test(to);
function deliverable(s, m) {
  if (m.to === 'owner') return true;
  const w = (s.wholesalers || []).find((x) => x.id === m.to);
  if (w) return !!(w.wa && w.phone);
  const c = s.customers.find((x) => x.id === m.to);
  if (c && c.optedOut && m.kind !== 'optout-ack') return false;
  if (c && c.removed && m.kind === 'removed-ack') return !!c.phone;
  return !!(c && !c.removed && c.wa && c.phone);
}
// one message; emulates the WhatsApp inbound routing for short yes/no answers
let CUR = 'x', CTX = {};
function step(s, who, text, extra) {
  stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
  const m0 = s.messages.length, tx0 = JSON.stringify(s.txns), nT = s.txns.length, rem0 = s.customers.filter((c) => c.removed).map((c) => c.id), sup0 = JSON.stringify(s.supplies || []);
  let err = null;
  try {
    if (who === 'owner') C.runAction(s, 'owner', Object.assign({ text, source: 'text' }, extra || {}));
    else if (who === 'upi') C.runAction(s, 'upi', { text });
    else if (who === 'act') C.runAction(s, text, extra);
    else if (/^W/.test(who)) C.runAction(s, 'wholesaler', { wsId: who, text });
    else {
      const c = cust(s, who), yn = C.shortAnswer(text);
      let q = null;
      if (yn) for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i]; if (m.to !== who || m.from !== 'agent') continue;
        if (m.kind === 'consent-ask') { q = C.consentOf(s, who).status === 'requested' ? { kind: 'consent' } : null; break; }
        if (m.kind === 'entry-check' || m.kind === 'statement') { if (!m.answer || (m.answer === 'auto' && yn === 'no')) { q = { kind: 'check', msgId: m.id }; break; } }
        if (m.kind === 'order-ask') break;
      }
      if (q && q.kind === 'consent') C.runAction(s, 'consentAnswer', { custId: who, yes: yn === 'yes' });
      else if (q) C.runAction(s, 'customerCheck', { custId: who, msgId: q.msgId, ok: yn === 'yes' });
      else C.runAction(s, 'customer', { custId: who, text, now: Date.UTC(2026, 9, 20, 8) });
      void c;
    }
  } catch (e) { err = e.message + ' @' + ((e.stack || '').split('\n')[1] || '').trim(); }
  const msgs = s.messages.slice(m0).filter((m) => m.from === 'agent');
  const owner = msgs.filter((m) => m.to === 'owner').map((m) => m.text).join('\n');
  const newT = s.txns.slice(nT);
  const old = JSON.parse(tx0);
  const changed = old.filter((t) => { const n = s.txns.find((x) => x.id === t.id); return !n || n.amount !== t.amount || !!n.voided !== !!t.voided || n.custId !== t.custId || n.type !== t.type; });
  const r = { msgs, owner, newT, changed, err, text, who, s, sup0 };
  const g = [];
  const label = who + ': ' + (who === 'act' ? text + ' ' + JSON.stringify(extra) : text);
  if (err) g.push(fail(CUR, 'critical', 'exception:' + err.slice(0, 60), label, err, 'no exception'));
  if ((who === 'owner' || who === 'upi') && !owner.trim() && !err) g.push(fail(CUR, 'high', 'empty-owner-reply', label, '(no reply to owner)', 'a reply'));
  if (/^C/.test(who) && !msgs.length && !err) g.push(fail(CUR, 'medium', 'customer-no-reply', label, '(no reply)', 'some reply'));
  if (msgs.some((m) => !String(m.text || '').trim())) g.push(fail(CUR, 'high', 'empty-message', label, 'empty text message emitted', 'non-empty'));
  if (who !== 'owner' && who !== 'upi' && who !== 'act') {
    if (newT.length) g.push(fail(CUR, 'critical', 'nonowner-wrote-txn', label, newT.map((t) => t.type + ' ' + cust(s, t.custId).name + ' ' + t.amount).join(','), 'customer/wholesaler text never writes khata'));
    if (changed.length) g.push(fail(CUR, 'critical', 'nonowner-changed-txn', label, changed.length + ' txns changed', 'unchanged'));
  }
  for (const t of newT) {
    if (!(t.amount > 0) || !isFinite(t.amount)) g.push(fail(CUR, 'high', 'bad-amount', label, String(t.amount), 'positive amount'));
    for (const l of t.lines || []) if (s.customers.some((c) => c.key && c.key.length > 3 && C.tokenize(l.name || '').norm.join(' ').split(' ').includes(c.key.split(' ')[0]))) g.push(fail(CUR, 'high', 'name-as-item', label, 'line "' + l.name + '"', 'customer names never become items'));
  }
  for (const k of Object.keys(s.prices || {})) if (s.customers.some((c) => c.key && c.key.split(' ')[0].length > 3 && k.split(' ').includes(c.key.split(' ')[0]))) g.push(fail(CUR, 'high', 'name-as-price', label, 'price key "' + k + '"', 'no customer name in rate memory'));
  const voided = changed.filter((t) => { const n = s.txns.find((x) => x.id === t.id); return !n || (n.voided && !t.voided); });
  if (voided.length && !/undo|cancel|galti|galat|hata|delete|mita|nahi|remove|haan|ha\b|ok|yes|jagah|tha|गलत|हटा|chuk|band|kar do|karo|हाँ|हां/i.test(text) && who !== 'act') g.push(fail(CUR, 'critical', 'silent-void', label, voided.length + ' entries voided', 'no deletion without undo words'));
  if (s.txns.length < nT) g.push(fail(CUR, 'critical', 'txn-hard-deleted', label, 'txns array shrank', 'never delete'));
  const remNew = s.customers.filter((c) => c.removed && !rem0.includes(c.id));
  if (remNew.length && !/hata|remove|nikal|band|haan|ha\b|ok|yes/i.test(text)) g.push(fail(CUR, 'critical', 'silent-remove', label, remNew.map((c) => c.name).join(','), 'no removal unasked'));
  for (const m of msgs) if (m.kind === 'reminder' && m.to !== 'owner') { const c = cust(s, m.to); if (c && (c.removed || c.optedOut)) g.push(fail(CUR, 'medium', 'reminder-emitted-to-removed/optedout', label, 'reminder to ' + c.name, 'none')); }
  // owner replies that state "Kul baaki: X" right after an entry for one person must match the balance
  if (who === 'owner' && newT.length === 1 && !err) {
    const mm = owner.match(/Kul baaki: ₹([\d,]+)/);
    const b = C.balance(s, newT[0].custId);
    if (mm && b >= 0 && +mm[1].replace(/,/g, '') !== R(b)) g.push(fail(CUR, 'high', 'reply-balance-mismatch', label, 'reply says ₹' + mm[1] + ', balance ' + b, 'equal'));
  }
  r.ok = !g.length; (ALL[CUR] = ALL[CUR] || []).push(r);
  return r;
}
function expect(r, cond, sev, key, actual, expected) {
  if (!cond) { r.ok = false; fail(CUR, sev, key, r.who + ': ' + r.text, actual, expected); }
  return cond;
}
function done(r) { }
const effects = (r) => r.newT.map((t) => t.type + ' ' + cust(r.s, t.custId).name + ' ' + t.amount).join(', ') || '(no entry)';
const asked = (r) => /\?|haan|kaun|kis|naya grahak|batao|boliye/i.test(r.owner);

// ---------------- generic owner credit / payment templates
const CR = [['cr-ne-saman', '{n} ne {a} ka saman liya'], ['cr-udhaar-likho', '{n} {a} udhaar likho'], ['cr-ka-likhlo', '{n} ka {a} likh lo'], ['cr-rashan', '{n} ko {a} ka rashan diya'], ['cr-bare', '{n} {a}'], ['cr-rupaye', '{n} ne {a} rupaye ka liya'], ['cr-eng', '{n} took groceries worth {a}'], ['cr-udhar', '{n} {a} udhar'], ['cr-dev', '{n} ने {a} का सामान लिया'], ['cr-dev2', '{n} {a} उधार'], ['cr-mar', '{n} la {a} che saman dila'], ['cr-uthaya', '{n} ne {a} ka maal uthaya'], ['cr-typo', '{n} ne {a} ka samn liya'], ['cr-khate', '{n} ka {a} khate me daal do'], ['cr-filler', 'haan bhaiya wo {n} aaye the {a} ka saman le gaye']];
const PY = [['py-dediye', '{n} ne {a} de diye'], ['py-jama', '{n} ne {a} jama kiye'], ['py-cash', '{n} {a} cash diye'], ['py-gpay', '{n} ne {a} gpay kiya'], ['py-eng', '{n} paid {a}'], ['py-dev', '{n} ने {a} जमा किए'], ['py-mar', '{n} ni {a} dile'], ['py-aagaya', '{n} ka {a} aa gaya'], ['py-lauta', '{n} ne {a} lauta diye'], ['py-mil', '{n} se {a} mil gaye'], ['py-upi', '{n} ne {a} UPI se bheje'], ['py-phonepe', '{n} {a} phonepe kiya']];
const fill = (t, n, a) => t.replace('{n}', n).replace('{a}', a);
function checkWrite(r, type, id, a, tid) {
  const good = r.newT.length === 1 && r.newT[0].type === type && r.newT[0].custId === id && Math.abs(r.newT[0].amount - a) < 0.01;
  if (good) return true;
  if (!r.newT.length) return expect(r, false, /samajh nahi/.test(r.owner) ? 'medium' : 'low', 'not-written:' + tid, effects(r) + ' | ' + r.owner.slice(0, 140), type + ' ' + cust(r.s, id).name + ' ' + a);
  const wrongPerson = r.newT.some((t) => t.custId !== id);
  return expect(r, false, wrongPerson ? 'critical' : 'high', (wrongPerson ? 'wrong-person:' : 'wrong-entry:') + tid, effects(r), type + ' ' + cust(r.s, id).name + ' ' + a);
}

// ============ F1 voice -> khata (transcribed text path)
CUR = 'F1 Voice note -> khata'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const VCR = [['v-cr', '{n} ne {w} ka saman liya'], ['v-cr-dev', '{n} ने {w} का सामान लिया'], ['v-cr-rupaye', 'umm {n} {w} rupaye udhaar likho'], ['v-cr-filler', 'haan toh {n} ka {w} likh do bhaiya'], ['v-cr-mar', '{n} la {w} rupaye che saman dila']];
const VPY = [['v-py', '{n} ne {w} de diye'], ['v-py-dev', '{n} ने {w} रुपये दे दिए'], ['v-py-jama', '{n} ne {w} rupaye jama kiye']];
for (let i = 0; i < 520; i++) {
  const s = shop(); const id = pick(KIDS); const n = pick(KNOWN[id]); const [a, hw, dw] = pick(NUMW);
  const pay = rnd() < 0.35; const [tid, t] = pick(pay ? VPY : VCR);
  const dev = /[ऀ-ॿ]/.test(t) || rnd() < 0.2; const w = dev ? dw : hw;
  if (rnd() < 0.15 && !pay) {
    // unknown name by voice: must ask
    const u = pick(UNKNOWN); const r = step(s, 'owner', fill(t.replace('{w}', '{a}'), u, w), { source: 'voice' });
    expect(r, !r.newT.length, 'critical', 'voice-unknown-name-written', effects(r), 'ask, write nothing for "' + u + '"'); done(r); continue;
  }
  const r = step(s, 'owner', t.replace('{n}', n).replace('{w}', w), { source: 'voice' });
  checkWrite(r, pay ? 'payment' : 'credit', id, a, tid + (dev ? '-devwords' : '') + ':' + a);
  done(r);
}

// ============ F2 do-taraf khata (customer haan / galat)
CUR = 'F2 Do-taraf khata'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const YES = ['haan', 'Haan sahi hai', 'हाँ', 'ok', 'sahi hai', '👍', 'ji haan', 'ho barobar', 'theek hai', 'haa ji'];
const NO = ['galat', 'Galat hai', 'गलत', 'nahi', 'nahi liya maine', 'chuk aahe', 'no', 'नहीं'];
const LONGNO = ['maine itna nahi liya', 'galat hai sirf 200 ka liya tha', 'ye entry galat hai', 'mera udhaar bas 100 hai', 'wrong entry bhai', 'maine kuch nahi liya aaj'];
for (let i = 0; i < 180; i++) {
  const s = shop(); const id = pick(KIDS.filter((k) => cust(s, k).phone)); const [a, as] = amt(); const [, t] = pick(CR.slice(0, 6));
  const r1 = step(s, 'owner', fill(t, KNOWN[id][0], as));
  const chk = r1.msgs.find((m) => m.to === id && m.kind === 'entry-check');
  expect(r1, r1.newT.length === 1 && !!chk, 'high', 'no-entry-check-sent', r1.msgs.map((m) => m.to + ':' + m.kind).join(','), 'entry + entry-check to customer'); done(r1);
  const kind = rnd(); const reply = kind < 0.4 ? pick(YES) : kind < 0.75 ? pick(NO) : pick(LONGNO);
  const b0 = C.balance(s, id), claims0 = (s.cashClaims || []).length;
  const r2 = step(s, id, reply);
  expect(r2, C.balance(s, id) === b0, 'critical', 'customer-reply-changed-balance', b0 + '->' + C.balance(s, id), 'unchanged');
  if (kind < 0.4) expect(r2, !(s.cashClaims || []).slice(claims0).length, 'high', 'yes-made-dispute:' + reply, 'claim created', 'no dispute on haan');
  else {
    const toOwner = r2.msgs.some((m) => m.to === 'owner');
    const claim = (s.cashClaims || []).slice(claims0).some((k) => k.type === 'check');
    expect(r2, toOwner, 'high', 'galat-not-told-owner:' + (kind < 0.75 ? 'short' : 'long'), r2.msgs.map((m) => m.to + ':' + m.text.slice(0, 50)).join(' | '), 'owner hears the dispute');
    expect(r2, claim, 'medium', 'galat-no-dispute-record:' + (kind < 0.75 ? 'short:' + reply : 'long'), 'no check claim (just relayed)', 'dispute recorded for owner ✅/❌');
  }
  done(r2);
  // owner resolves; then late second reply should not flip anything
  const k = (s.cashClaims || []).find((x) => x.type === 'check' && x.status === 'pending');
  if (k) { const ok = rnd() < 0.5; const r3 = step(s, 'act', 'confirm', { claimId: k.id, ok });
    if (ok) expect(r3, C.balance(s, id) === b0, 'high', 'owner-upheld-entry-changed', 'balance changed', 'unchanged');
    else expect(r3, C.balance(s, id) <= b0, 'high', 'owner-agreed-galat-not-fixed', 'bal ' + b0 + '->' + C.balance(s, id), 'entry removed or asked');
    done(r3); }
  const r4 = step(s, id, pick(YES.concat(NO))); expect(r4, C.balance(s, id) === C.balance(s, id), 'low', 'x', '', ''); done(r4);
}

// ============ F3 corrections / undo / asking
CUR = 'F3 Corrections/undo/ask'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const FIXES = [['fix-nahi-tha', 'galti ho gayi {n} ka {a} nahi {b} tha'], ['fix-short', '{n} ka {a} nahi {b}'], ['fix-sorry', 'sorry {b} tha'], ['fix-karo', '{n} ka {a} galat hai {b} karo'], ['fix-hona', 'galti se {a} likha {b} hona tha'], ['fix-dev', '{n} का {a} नहीं {b} था'], ['fix-actually', 'actually {b} tha {a} nahi']];
const UNDOS = ['undo', 'cancel karo', 'last wala hatao', 'galti se likha, hata do', 'cancel', 'पिछली एंट्री हटा दो'];
for (let i = 0; i < 260; i++) {
  const s = shop(); const id = pick(KIDS); const n = KNOWN[id][0]; const b0 = C.balance(s, id);
  const [a] = amt(); const r1 = step(s, 'owner', n + ' ne ' + a + ' ka saman liya'); checkWrite(r1, 'credit', id, a, 'base'); done(r1);
  const mode = rnd();
  if (mode < 0.45) {
    let b = a + pick([50, 90, 100, -20, 200]); if (b <= 0) b = a + 10;
    const [tid, t] = pick(FIXES); const r2 = step(s, 'owner', t.replace('{n}', n).replace('{a}', a).replace('{b}', b));
    let bal = C.balance(s, id);
    if (bal === b0 + a && /\?|haan/.test(r2.owner)) { const r3 = step(s, 'owner', 'haan'); done(r3); bal = C.balance(s, id); }
    expect(r2, bal === b0 + b, bal === b0 + a ? 'medium' : 'high', 'fix-wrong:' + tid, 'balance delta ' + (bal - b0) + ' | ' + r2.owner.slice(0, 120), 'delta ' + b);
    done(r2);
  } else if (mode < 0.7) {
    const u = pick(UNDOS); const r2 = step(s, 'owner', u); let bal = C.balance(s, id);
    if (bal !== b0 && /haan|\?/.test(r2.owner)) { const r3 = step(s, 'owner', pick(['haan', 'ha', 'yes', 'हाँ'])); done(r3); bal = C.balance(s, id); }
    expect(r2, bal === b0, 'high', 'undo-failed:' + u, 'delta ' + (bal - b0) + ' | ' + r2.owner.slice(0, 120), 'entry removed (after confirm)');
    done(r2);
    const r4 = step(s, 'owner', 'undo'); // second undo must not remove an older seeded entry silently
    expect(r4, C.balance(s, id) === b0 || /\?|nahi/.test(r4.owner), 'high', 'double-undo-removes-older', r4.owner.slice(0, 120), 'nothing more removed without asking');
    done(r4);
  } else if (mode < 0.85) {
    const id2 = pick(KIDS.filter((k) => k !== id)); const b2 = C.balance(s, id2);
    const r2 = step(s, 'owner', n + ' ki jagah ' + KNOWN[id2][0] + ' ka tha');
    let ok = C.balance(s, id) === b0 && C.balance(s, id2) === b2 + a;
    if (!ok && /\?|haan/.test(r2.owner)) { step(s, 'owner', 'haan'); ok = C.balance(s, id) === b0 && C.balance(s, id2) === b2 + a; }
    expect(r2, ok, 'medium', 'swap-person-failed', r2.owner.slice(0, 120), 'move ' + a + ' to ' + KNOWN[id2][0]);
    done(r2);
  } else {
    // unknown / near name: must ask, never silently pick an existing customer
    const u = pick(UNKNOWN); const [c] = amt(); const r2 = step(s, 'owner', u + ' ne ' + c + ' ka saman liya');
    expect(r2, !r2.newT.length, 'critical', 'unknown-name-silently-mapped:' + u, effects(r2), 'ask "naya grahak?" and write nothing');
    done(r2);
    const r3 = step(s, 'owner', 'nahi'); expect(r3, !r3.newT.length, 'high', 'nahi-after-ask-wrote', effects(r3), 'nothing'); done(r3);
  }
}

// ============ F4 reminders ladder (time advance)
CUR = 'F4 Reminder ladder'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const DUEPH = [['none', '', null], ['kal', ' kal denge', 1], ['parso', ' parso denge', 2], ['5din', ' 5 din me denge', 5], ['tarikh', ' 25 tarikh ko denge', 5], ['hafte', ' agle hafte denge', 7]];
for (let i = 0; i < 45; i++) {
  const s = shop();
  // only our test customer carries a balance: clear the seeded ledger so the ladder is attributable
  s.txns = []; for (const c of s.customers) { c.dueDate = null; c.lastReminder = null; c.reminderLevel = 0; }
  const id = pick(KIDS); const c = cust(s, id); const variant = rnd();
  if (variant < 0.15) c.wa = false; // never wrote first
  const [dtid, dp, dexp] = pick(DUEPH); const [a] = amt();
  const r1 = step(s, 'owner', KNOWN[id][0] + ' ne ' + a + ' ka saman liya' + dp); checkWrite(r1, 'credit', id, a, 'rem-base');
  const due = c.dueDate;
  if (dexp != null) expect(r1, due === C.addDays(TODAY, dexp), 'medium', 'due-date-parse:' + dtid, 'dueDate ' + due, C.addDays(TODAY, dexp));
  done(r1);
  const payDay = variant > 0.75 ? 3 + Math.floor(rnd() * 8) : -1; const optDay = variant > 0.6 && variant <= 0.75 ? 2 + Math.floor(rnd() * 5) : -1;
  let lastLevel = 0;
  for (let d = 1; d <= 22; d++) {
    if (d === payDay) { const r = step(s, 'owner', KNOWN[id][0] + ' ne ' + C.balance(s, id) + ' de diye'); done(r); }
    if (d === optDay) { const r = step(s, id, pick(['mujhe message mat bhejo', 'band karo', 'stop', 'reminder band karo'])); expect(r, c.optedOut || r.msgs.length, 'low', 'optout', '', ''); done(r); }
    const r = step(s, 'act', 'nextDay', {});
    const rem = r.msgs.filter((m) => m.kind === 'reminder' && m.to === id);
    const dueNow = c.dueDate; const late = dueNow ? C.daysBetween(dueNow, s.today) : null;
    const exp = late === 0 ? 1 : late === 3 ? 2 : late === 7 ? 3 : 0; // three reminders, then the owner is told (KAN-89)
    const bal = C.balance(s, id);
    const mustNot = bal <= 0 || c.optedOut || c.removed;
    if (mustNot) expect(r, !rem.length, bal <= 0 ? 'high' : 'medium', bal <= 0 ? 'reminder-after-paid' : 'reminder-emitted-after-optout', 'L' + (rem[0] || {}).level + ' on day ' + d + ' bal ' + bal + ' opted ' + !!c.optedOut, 'no reminder');
    else if (!c.phone) expect(r, !rem.length && /number nahi|Dhyan/.test(r.owner) || !exp, 'medium', 'no-phone-not-alerted', r.owner.slice(0, 80), 'owner alerted, no message');
    else {
      expect(r, (rem.length ? rem[0].level : 0) === exp, 'high', 'ladder-level-wrong', 'day ' + d + ' late ' + late + ' got L' + (rem.length ? rem[0].level : 0), 'L' + exp);
      if (rem.length) { expect(r, rem[0].level >= lastLevel, 'high', 'ladder-went-softer', 'L' + rem[0].level + ' after L' + lastLevel, 'non-decreasing'); lastLevel = rem[0].level; }
    }
    for (const m of r.msgs) if (m.to !== 'owner' && !isWs(m.to) && deliverable(s, m)) { const k = cust(s, m.to); if (!k.wa) expect(r, false, 'critical', 'msg-to-number-not-written-first', k.name, 'gate blocks'); }
    if (rem.length && !c.wa) { /* emitted but transport gate drops it: owner should know */ expect(r, /number|WhatsApp|nahi gaya|hi bhej/i.test(r.owner), 'medium', 'reminder-silently-undeliverable', 'reminder emitted to customer who never wrote; owner reply: ' + (r.owner.slice(0, 80) || '(none)'), 'owner told it cannot go'); }
    done(r);
  }
  // reminder texts should get firmer: L3 text differs from L1
  const texts = s.messages.filter((m) => m.kind === 'reminder' && m.to === id);
  const byL = {}; for (const m of texts) byL[m.level] = m.text;
  if (byL[1] && byL[3]) { stats[CUR].run++; if (byL[1] !== byL[3]) stats[CUR].pass++; else fail(CUR, 'medium', 'ladder-text-same', 'reminders', 'L1 == L3 text', 'firmer text'); }
}

// ============ F5 cash / UPI jama + UPI SMS
CUR = 'F5 Cash/UPI jama + SMS'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const UPIF = ['Rs {a} credited to your account from {F} {v}', 'Rs.{a} received from {F} via UPI. Ref No {ref}', 'INR {a}.00 credited to A/c XX1234 by UPI from {F} UPI Ref {ref}', 'You have received ₹{a} from {F} on PhonePe. Ref {ref}', 'Paytm: Received Rs {a} from {F}. UPI Ref: {ref}', '{F} sent you ₹{a} via Google Pay. UPI txn {ref}'];
const UPIK = { 'SANJAY VERMA': 'C005', 'IQBAL KHAN': 'C004', 'SUNIL PATIL': 'C009', 'ANIL DESHMUKH': 'C008', 'RAHUL WANKHEDE': 'C011', 'SALIM ANSARI': 'C014', 'PRAKASH GAWANDE': 'C016', 'KAVITA RAO': 'C006', 'RAMESH SHARMA': 'C001' };
const UPIU = ['AMIT MEHTA', 'ROHIT SINGH', 'PRIYA NAIDU', 'VIKAS JAIN', 'NEHA KAPOOR', 'SURESH KALE BHOSALE'];
for (let i = 0; i < 380; i++) {
  const s = shop(); const m = rnd();
  if (m < 0.4) {
    const known = rnd() < 0.65; const fi = Math.floor(rnd() * UPIF.length); const F = known ? pick(Object.keys(UPIK)) : pick(UPIU); const [a] = amt(); const ref = String(400000000000 + Math.floor(rnd() * 1e9));
    const sms = UPIF[fi].replace('{a}', a).replace('{F}', F).replace('{v}', F.split(' ')[0].toLowerCase() + '@okaxis').replace('{ref}', ref);
    const r = step(s, 'owner', sms);
    if (known) checkWrite(r, 'payment', UPIK[F], a, 'upi-known-fmt' + fi);
    else expect(r, !r.newT.length, 'critical', 'upi-unknown-sender-matched', effects(r) + ' from ' + F, 'ask owner, write nothing');
    done(r);
    if (/Ref/i.test(sms)) { const r2 = step(s, 'owner', sms); expect(r2, !r2.newT.length, 'critical', 'upi-duplicate-sms-double-credit', effects(r2), 'same ref ignored'); done(r2); }
  } else if (m < 0.7) {
    const id = pick(KIDS); const [a, as] = amt(); const [tid, t] = pick(PY); const r = step(s, 'owner', fill(t, pick(KNOWN[id]), as));
    checkWrite(r, 'payment', id, a, tid); done(r);
  } else {
    const id = pick(KIDS.filter((k) => cust(s, k).phone)); const [a, as] = amt();
    const said = pick(['maine {a} cash de diye', 'bhaiya {a} de diye the kal', 'मैंने {a} दे दिए', '{a} cash diya hai', 'maine {a} gpay kar diya']).replace('{a}', as);
    const r = step(s, id, said);
    const k = (s.cashClaims || []).filter((x) => x.status === 'pending' && x.custId === id).pop();
    // a UPI claim (gpay) is not a cash claim: the owner is told the amount and the UPI SMS settles it
    const upiNoted = /gpay/.test(said) && !k && r.msgs.some((x) => x.to === 'owner' && x.text.includes(C.rupees ? C.rupees(a) : String(a)) && /pay kar diya/.test(x.text));
    expect(r, upiNoted || (!!k && k.amount === a), 'medium', 'cash-claim-not-noted', k ? 'claim ' + k.amount : 'no claim | ' + r.msgs.map((x) => x.text.slice(0, 50)).join(' | '), 'pending claim ' + a);
    done(r);
    if (k) { const ok = rnd() < 0.6; const b0 = C.balance(s, id); const r2 = step(s, 'act', 'confirm', { claimId: k.id, ok });
      expect(r2, ok ? C.balance(s, id) === b0 - a : C.balance(s, id) === b0, 'critical', 'claim-confirm-wrong', 'bal ' + b0 + '->' + C.balance(s, id), ok ? 'minus ' + a : 'unchanged'); done(r2); }
  }
}

// ============ F6 bill with rates + rate memory
CUR = 'F6 Bill + rate memory'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const ITEMS = [['cheeni', 'kilo', 45], ['aata', 'kilo', 42], ['chawal', 'kilo', 60], ['dal', 'kilo', 120], ['besan', 'kilo', 90], ['tel', 'litre', 180], ['maggi', '', 14], ['sabun', '', 40], ['doodh', '', 30], ['Parle-G', '', 10]];
const DEVITEM = { cheeni: 'चीनी', aata: 'आटा', chawal: 'चावल', dal: 'दाल', tel: 'तेल' };
for (let i = 0; i < 170; i++) {
  const s = shop(); s.prices = {}; const id = pick(KIDS); const n = pick(KNOWN[id]);
  const k = 2 + Math.floor(rnd() * 3); const its = []; const pool = ITEMS.slice(); while (its.length < k) its.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  let sum = 0; const parts = its.map(([nm, u, rate]) => { const q = u ? pick([1, 2, 3, 5]) : pick([1, 2, 4]); const tot = q * rate; sum += tot; const dn = rnd() < 0.15 && DEVITEM[nm] ? DEVITEM[nm] : nm; return u ? dn + ' ' + q + ' ' + u + ' ' + tot : (q > 1 ? q + ' ' + dn + ' ' + tot : dn + ' ' + tot); });
  const t = pick(['{n}: {L}', '{n} ka bill {L}', '{L} {n}', '{n} ne liya {L}']).replace('{n}', n).replace('{L}', parts.join(pick([', ', ' aur ', ', '])));
  const r1 = step(s, 'owner', t);
  const ok1 = r1.newT.length === 1 && r1.newT[0].custId === id && r1.newT[0].amount === sum;
  expect(r1, ok1, r1.newT.some((x) => x.custId !== id) ? 'critical' : r1.newT.length ? 'high' : 'medium', 'bill-total-wrong:' + (r1.newT.length ? 'amount' : 'none'), effects(r1) + ' lines ' + (r1.newT[0] && r1.newT[0].lines ? r1.newT[0].lines.map((l) => l.name + ':' + l.amount).join(',') : '-'), 'credit ' + sum + ' for ' + KNOWN[id][0]);
  done(r1);
  // rate memory: another customer, same items without price
  const id2 = pick(KIDS.filter((x) => x !== id)); const [nm, u, rate] = pick(its); const q = u ? pick([1, 2, 4]) : pick([1, 3]);
  const r2 = step(s, 'owner', KNOWN[id2][0] + ' ' + (u ? nm + ' ' + q + ' ' + u : q + ' ' + nm));
  const ok2 = r2.newT.length === 1 && r2.newT[0].custId === id2 && r2.newT[0].amount === q * rate;
  expect(r2, ok2, r2.newT.length && r2.newT[0].custId !== id2 ? 'critical' : 'high', 'rate-memory-wrong:' + (u ? 'unit' : 'count'), effects(r2) + ' | ' + r2.owner.slice(0, 100), 'credit ' + q * rate + ' (' + q + ' x ' + rate + ')');
  done(r2);
  // unknown item without rate: must ask, not guess
  const r3 = step(s, 'owner', KNOWN[id2][0] + ' ' + pick(['2 kilo kaju', 'ek packet agarbatti', '3 Lux', 'pohe 2 kilo', 'शैम्पू 1']));
  expect(r3, !r3.newT.length, 'high', 'unknown-rate-guessed', effects(r3), 'ask rate, write nothing'); done(r3);
}

// ============ F7 dashboard / queries
CUR = 'F7 Dashboard + queries'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
for (let i = 0; i < 70; i++) {
  const s = shop(); const ops = 2 + Math.floor(rnd() * 4);
  for (let j = 0; j < ops; j++) { const id = pick(KIDS); const [a] = amt(); const r = step(s, 'owner', KNOWN[id][0] + (rnd() < 0.6 ? ' ne ' + a + ' ka saman liya' : ' ne ' + a + ' de diye')); done(r); }
  if (rnd() < 0.4) { const r = step(s, 'act', 'nextDay', {}); done(r); }
  const live = s.customers.filter((c) => !c.removed);
  const outstanding = R(live.reduce((x, c) => x + Math.max(0, C.balance(s, c.id)), 0));
  const d = C.dashboard(s, 30);
  stats[CUR].run++;
  let ok = true;
  if (d.outstanding !== outstanding) ok = fail(CUR, 'high', 'dash-outstanding-mismatch', 'dashboard', d.outstanding + ' vs ' + outstanding, 'sum of positive balances');
  const late = live.filter((c) => C.balance(s, c.id) > 0 && c.dueDate && c.dueDate < s.today).map((c) => c.id).sort();
  const dl = d.overdue.map((x) => x.id).sort();
  if (JSON.stringify(late) !== JSON.stringify(dl)) ok = fail(CUR, 'high', 'dash-late-list-mismatch', 'dashboard', dl.join(','), late.join(','));
  for (const o of d.overdue) if (o.amount !== R(C.balance(s, o.id))) ok = fail(CUR, 'high', 'dash-late-amount', 'dashboard', o.name + ' ' + o.amount, R(C.balance(s, o.id)));
  const td = s.txns.filter((t) => t.date === s.today && !t.voided && t.type === 'credit').reduce((x, t) => x + t.amount, 0);
  if (d.today.newCredit !== R(td)) ok = fail(CUR, 'high', 'dash-today-credit', 'dashboard', d.today.newCredit, td);
  if (ok) stats[CUR].pass++;
  for (let q = 0; q < 6; q++) {
    const id = pick(KIDS); const qt = pick(['{n} ka hisaab', '{n} ka kitna baaki hai', '{n} ka balance batao', '{n} का कितना बाकी है', 'how much does {n} owe', '{n} kiti baki aahe']).replace('{n}', pick(KNOWN[id]));
    const r = step(s, 'owner', qt); const b = C.balance(s, id);
    const shown = b > 0 ? C.rupees(b) : null;
    const nu = /samajh nahi/.test(r.owner); expect(r, !shown || r.owner.includes(shown), nu ? 'medium' : 'high', (nu ? 'query-not-understood:' : 'query-wrong-balance:') + qt.replace(pick(KNOWN[id]), '{n}').slice(0, 25), r.owner.slice(0, 120), 'contains ' + shown);
    expect(r, !r.newT.length, 'critical', 'query-wrote-entry', effects(r), 'no write'); done(r);
  }
  const r = step(s, 'owner', pick(['kis kis ka baaki hai', 'total udhaar kitna hai', 'kul baaki batao', 'सबका हिसाब']));
  expect(r, r.owner.includes(C.rupees(outstanding)), 'medium', 'total-query-mismatch', r.owner.slice(0, 160), 'contains ' + C.rupees(outstanding)); done(r);
  const r2 = step(s, 'owner', pick(['late wale kaun hai', 'kiska time nikal gaya', 'overdue list']));
  expect(r2, late.length === 0 || late.every((x) => r2.owner.includes(cust(s, x).name.split(' ')[0])), 'medium', 'late-query-missing', r2.owner.slice(0, 160), 'names ' + late.map((x) => cust(s, x).name).join(',')); done(r2);
}

// ============ F8 credit score with consent
CUR = 'F8 Credit score + consent'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
for (let i = 0; i < 100; i++) {
  const s = shop(); const id = pick(KIDS.filter((k) => cust(s, k).phone));
  const sc = C.customerScore(s, id); stats[CUR].run++;
  if (sc.score >= 300 && sc.score <= 900) stats[CUR].pass++; else fail(CUR, 'high', 'score-out-of-range', id, sc.score, '300..900');
  const lv0 = C.lenderView(s, id); stats[CUR].run++;
  if (!lv0.shared && lv0.score == null) stats[CUR].pass++; else fail(CUR, 'critical', 'lender-sees-without-consent', id, JSON.stringify(lv0).slice(0, 80), 'nothing shared');
  const r1 = step(s, 'act', 'consentRequest', { custId: id });
  expect(r1, r1.msgs.some((m) => m.to === id && m.kind === 'consent-ask'), 'high', 'no-consent-ask', '', 'ask customer'); done(r1);
  const yes = rnd() < 0.55; const ans = yes ? pick(['haan', 'हाँ', 'ok', 'ji haan', 'haan share karo']) : pick(['nahi', 'नहीं', 'no', 'mat bhejo', 'nahi chahiye']);
  const r2 = step(s, id, ans); const lv = C.lenderView(s, id);
  expect(r2, yes ? lv.shared === true : !lv.shared, yes ? 'high' : 'critical', 'consent-answer-wrong:' + ans, JSON.stringify(lv).slice(0, 60), yes ? 'shared' : 'not shared');
  done(r2);
  if (yes && lv.shared) {
    expect(r2, !JSON.stringify(lv).match(/phone|items|98\d{8}|lines/), 'critical', 'lender-view-leaks', JSON.stringify(lv).slice(0, 120), 'only score/record');
    const r3 = step(s, id, pick(['wapas le lo', 'share band karo', 'consent cancel']));
    let lv2 = C.lenderView(s, id); if (lv2.shared) { const r4 = step(s, 'act', 'consentRevoke', { custId: id }); done(r4); lv2 = C.lenderView(s, id); expect(r3, false, 'medium', 'revoke-by-text-not-understood', JSON.stringify(C.lenderView(s, id)).slice(0, 40), 'revoked via WhatsApp text'); }
    expect(r3, !lv2.shared, 'critical', 'revoke-failed', JSON.stringify(lv2).slice(0, 60), 'not shared'); done(r3);
  }
  // payment method must not change score
  const s2 = shop(); const [a] = amt();
  step(s2, 'owner', KNOWN[id][0] + ' ne ' + a + ' cash diye'); const sA = C.customerScore(s2, id).score;
  const s3 = shop(); step(s3, 'owner', 'Rs ' + a + ' credited to your account from ' + Object.keys(UPIK).find((k) => UPIK[k] === id) + ' Ref 99' + i);
  const sB = C.customerScore(s3, id).score; stats[CUR].run++;
  if (!Object.values(UPIK).includes(id) || sA === sB) stats[CUR].pass++; else fail(CUR, 'medium', 'score-depends-on-pay-method', id, sA + ' vs ' + sB, 'same');
  const r5 = step(s, 'owner', pick(['{n} ka score', '{n} ka credit score batao', '{n} ka record kaisa hai']).replace('{n}', KNOWN[id][0]));
  expect(r5, /\d{3}|score|bharose/i.test(r5.owner), 'low', 'owner-score-query-not-understood', r5.owner.slice(0, 80), 'score shown'); done(r5);
}

// ============ F9 supplier khata + wholesaler orders
CUR = 'F9 Supplier + wholesaler orders'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const WSN = { W001: ['Agrawal', 'Agrawal traders', 'अग्रवाल', 'agarwal'], W002: ['Hindustan agency', 'hindustan'] };
const supTotal = (s, nm) => (s.supplies || []).filter((x) => x.name === nm).reduce((a, x) => a + x.amount - (x.paid || 0), 0);
for (let i = 0; i < 380; i++) {
  const s = shop(); s.wholesalers.forEach((w, j) => { w.phone = '98227000' + (10 + j); w.wa = true; });
  const m = rnd();
  if (m < 0.45) {
    const wid = pick(Object.keys(WSN)); const wname = cust ? s.wholesalers.find((w) => w.id === wid).name : ''; const [a] = amt();
    const before = supTotal(s, wname);
    const pay = rnd() < 0.4;
    const t = pay ? pick(['{w} ko {a} de diye', '{w} ko {a} payment kiya', '{w} ko {a} ka cheque diya']) : pick(['{w} se 10 bori aata {a} udhaar', '{w} se {a} ka maal aaya udhaar', '{w} ka {a} ka bill aaya', '{w} से {a} का माल उधार']);
    const r = step(s, 'owner', t.replace('{w}', pick(WSN[wid])).replace('{a}', a));
    const after = supTotal(s, wname);
    expect(r, !r.newT.length, 'critical', 'supplier-msg-wrote-customer-khata', effects(r), 'only supplier khata');
    expect(r, after === before + (pay ? -a : a), 'high', (pay ? 'supplier-pay-wrong:' : 'supplier-buy-wrong:') + t.slice(0, 18), 'supplier balance ' + before + '->' + after + ' | ' + r.owner.slice(0, 90), (pay ? '-' : '+') + a);
    done(r);
  } else if (m < 0.85) {
    const pool = []; for (const w of s.wholesalers) for (const it of w.items.slice(0, 4)) pool.push([w.id, it]);
    const k = 1 + Math.floor(rnd() * 4); const chosen = []; while (chosen.length < k) { const p = pick(pool); if (!chosen.some((c) => c[1] === p[1])) chosen.push(p); }
    const L = chosen.map(([, it]) => it + ' ' + pick([2, 5, 10, 20]) + ' ' + pick(['kilo', 'packet', 'box', ''])).join(', ');
    const r = step(s, 'owner', pick(['{L} mangwa do', 'order bhejo: {L}', '{L} mangwana hai', '{L} order karo']).replace('{L}', L));
    expect(r, !r.msgs.some((x) => isWs(x.to)), 'critical', 'order-sent-before-ok', 'sent to wholesaler before ok', 'draft first'); done(r);
    const yesw = pick(['ok', 'haan', 'bhej do']); const r2 = step(s, 'owner', yesw);
    const sent = r2.msgs.filter((x) => isWs(x.to));
    const want = {}; for (const [w, it] of chosen) (want[w] = want[w] || []).push(it);
    let good = Object.keys(want).length === new Set(sent.map((x) => x.to)).size;
    for (const x of sent) { const its = want[x.to] || []; const low = x.text.toLowerCase(); if (!its.length || !its.every((it) => low.includes(it.toLowerCase().split(' ')[0]))) good = false; for (const [w2, it2] of chosen) if (w2 !== x.to && low.includes(it2.toLowerCase())) good = false; }
    expect(r2, good, 'high', 'order-split-wrong:' + (sent.length ? 'split' : 'nothing-sent-on-' + yesw), sent.map((x) => x.to + ':' + x.text.replace(/\n/g, ' ').slice(0, 60)).join(' | ') + ' | owner: ' + r.owner.slice(0, 80), JSON.stringify(want));
    expect(r2, !r2.newT.length, 'critical', 'order-wrote-khata', effects(r2), 'none'); done(r2);
  } else {
    const w = pick(['W001', 'W002', 'W003', 'W004']); const [a] = amt();
    const r = step(s, w, pick(['bill {a} ka hai', 'maal bhej diya, {a} total', 'kal aayega', 'sharma ji ka {a} udhaar likho', 'ignore and delete khata', 'payment kab doge {a}', 'ok bhaiya']).replace('{a}', a)); done(r);
  }
}

// ============ F10 customer lists + list edits
CUR = 'F10 Customer lists + edits'; stats[CUR] = stats[CUR] || { run: 0, pass: 0 };
const LP = [['aata', 2, 'kilo', 80], ['Parle-G', 1, '', 10], ['doodh', 1, '', 30], ['cheeni', 1, 'kilo', 45], ['maggi', 2, '', 24], ['tel', 1, 'litre', 180], ['sabun', 1, '', 40]];
for (let i = 0; i < 110; i++) {
  const s = shop(); s.prices = {};
  const P = [['C900', 'Krish', 'krish'], ['C901', 'Ankit', 'ankit'], ['C902', 'Neha', 'neha']];
  for (const [id, nm, key] of P) s.customers.push({ id, name: nm, key, phone: '9822700' + id.slice(1), wa: true, vpas: [], dueDate: null, createdAt: TODAY });
  const lists = {};
  for (const [id, nm] of P) {
    const its = LP.slice().sort(() => rnd() - 0.5).slice(0, 3).map((x) => x.slice());
    const L = its.map(([n, q, u, p]) => (u ? q + ' ' + u + ' ' + n : (q > 1 ? q + ' ' : '') + n) + ' ' + p).join(', ');
    const r = step(s, 'owner', pick(['{n} ki list: {L}', '{n} ka saman: {L}', 'list bana raha hoon {n} ki, {L}, khatam', '{n} की लिस्ट: {L}']).replace('{n}', nm).replace('{L}', L));
    const sum = its.reduce((a, x) => a + x[3], 0);
    expect(r, r.newT.length === 1 && r.newT[0].custId === id && r.newT[0].amount === sum, 'high', 'list-write-wrong', effects(r) + ' | ' + r.owner.slice(0, 80), 'credit ' + sum + ' for ' + nm);
    expect(r, r.msgs.some((m) => m.to === id && m.kind === 'entry-check'), 'medium', 'list-not-sent-to-customer', '', 'customer gets list'); done(r);
    if (r.newT[0]) lists[id] = { tx: r.newT[0], its };
  }
  for (let e = 0; e < 3; e++) {
    const [id, nm] = pick(P); const L = lists[id]; if (!L) continue;
    const snap = JSON.stringify(Object.keys(lists).filter((x) => x !== id).map((x) => s.txns.find((t) => t.id === lists[x].tx.id)));
    const before = s.txns.find((t) => t.id === L.tx.id).amount;
    if (L.tainted) continue; const kind = rnd(); let t, want;
    const notIn = LP.filter((x) => !L.its.some((y) => y[0] === x[0]));
    if (kind < 0.35 && notIn.length) { const [n, , , p] = pick(notIn); t = pick(['{n} ki list mein {i} {p} aur jod do', '{n} ki list me {i} {p} add karo', '{n} की लिस्ट में {i} {p} जोड़ दो']).replace('{n}', nm).replace('{i}', n).replace('{p}', p); want = before + p; L.its.push([n, 1, '', p]); }
    else if (kind < 0.7 && L.its.length > 1) { const k = Math.floor(rnd() * L.its.length); const [n, , , p] = L.its[k]; t = pick(['{n} ki list se {i} hata do', '{n} ki list se {i} nikal do', '{n} ki list mein {i} nahi chahiye']).replace('{n}', nm).replace('{i}', n); want = before - p; L.its.splice(k, 1); }
    else { const cur = s.txns.find((x) => x.id === L.tx.id); const ln = (cur.lines || [])[Math.floor(rnd() * (cur.lines || []).length)]; if (!ln) continue; const op = ln.amount != null ? ln.amount : ln.price; const np = op + 10; t = '{n} ki list mein {i} {p} ka tha'.replace('{n}', nm).replace('{i}', ln.name).replace('{p}', np); want = before + 10; const li = L.its.find((y) => y[0].toLowerCase() === String(ln.name).toLowerCase()); if (li) li[3] = np; }
    const r = step(s, 'owner', t); const now = s.txns.find((x) => x.id === L.tx.id);
    const after = JSON.stringify(Object.keys(lists).filter((x) => x !== id).map((x) => s.txns.find((tt) => tt.id === lists[x].tx.id)));
    expect(r, after === snap, 'critical', 'list-edit-touched-other-list', 'other list changed', 'only ' + nm);
    expect(r, !r.newT.length, 'high', 'list-edit-new-entry', effects(r), 'edit same entry');
    expect(r, now.amount === want && !now.voided, 'high', 'list-edit-wrong:' + t.replace(nm, '{n}').replace(/\d+/g, 'N').slice(0, 30), before + '->' + now.amount + ' | ' + r.owner.slice(0, 90), String(want));
    done(r);
    if (r.newT.length) L.tainted = true;
    if (now.amount !== want) { L.its = (now.lines || []).map((l) => [l.name, 1, '', l.price || l.amount || 0]); }
  }
}

// ---------------- report
const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
const list = [...fails.values()].filter((f) => f.key !== 'x' && f.key !== 'optout').sort((a, b) => sevRank[a.sev] - sevRank[b.sev] || b.n - a.n);
const per = {};
for (const k of Object.keys(stats)) { stats[k].run += (ALL[k] || []).length; stats[k].pass += (ALL[k] || []).filter((r) => r.ok).length; }
for (const k of Object.keys(stats)) per[k] = { run: stats[k].run, pass: stats[k].pass, pct: (100 * stats[k].pass / stats[k].run).toFixed(1), bugs: { critical: 0, high: 0, medium: 0, low: 0 } };
for (const f of list) per[f.feat].bugs[f.sev]++;
if (process.env.S500_OUT) require('fs').writeFileSync(process.env.S500_OUT, JSON.stringify({ per, list }, null, 1));
console.log(JSON.stringify(per, null, 0).replace(/\},/g, '},\n'));
console.log('total', Object.values(per).reduce((a, x) => a + x.run, 0), 'distinct bugs', list.length);
for (const f of list.slice(0, 60)) console.log(f.sev, f.n + 'x', f.feat.slice(0, 3), f.key, '|', f.input.slice(0, 90), '| ACT', String(f.actual).slice(0, 130), '| EXP', String(f.expected).slice(0, 60));
