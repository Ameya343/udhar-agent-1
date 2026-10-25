// Runs one case from livetest/cases.js against the compiled core, on its own throwaway demo shop (never the live khata),
// and compares what the khata actually did with the hand-written expectation. runCase: owner text goes through the rules
// parser only, no model is called. runCaseAi: each owner message is first read by the model (read(state, text) gives the
// intent, as the server's brain.understandOwner does), then the same khata code runs; the server uses it for /test-run's
// "hand-checked cases on the AI" (server/ai-test.ts). Works in Node (module.exports) and in the page (self.UdhaarRunner).
(function (root, make) { if (typeof module === 'object' && module.exports) module.exports = make(); else root.UdhaarRunner = make(); })(typeof self !== 'undefined' ? self : this, function () {
  const rupee = (n) => '₹' + n;
  const show = (w) => w.map(([t, k, a]) => (t === 'credit' ? 'udhaar ' : 'jama ') + k + ' ' + rupee(a)).join(', ') || 'nothing written';
  function describe(e) {
    const p = [];
    if (e.writes) p.push(show(e.writes));
    if (e.none) p.push('nothing written');
    if (e.noExisting) p.push('nothing written on an existing khata');
    if (e.balances) for (const k in e.balances) p.push(k + ' baaki ' + rupee(e.balances[k]));
    if ('pay' in e) p.push(e.pay === false ? 'amount refused' : 'pay ' + rupee(e.pay));
    return p.join('; ');
  }
  // one case, step by step: yields { state, text } before each owner message and takes back the model's intent (or nothing)
  function* walk(C, kase, today) {
    const s = C.freshShop('gupta', today);
    const byName = (k) => s.customers.find((c) => c.name === k);
    const nameOf = (id) => { const c = s.customers.find((x) => x.id === id); return c ? c.name : id; };
    const existing = new Set(s.customers.map((c) => c.id));
    const out = { id: kase.id, cat: kase.cat, input: kase.steps.map((x) => x.text).join('  ⏎  '), expected: kase.steps.map((x) => describe(x.expect)).join('  ⏎  '),
      actual: '', pass: true, why: [], reply: '', note: kase.note };
    const actual = [];
    for (const st of kase.steps) {
      const e = st.expect, why = [];
      const before = JSON.stringify(s.txns), n = s.txns.length, m = s.messages.length;
      let got = '';
      try {
        if (st.who === 'owner') { const intent = yield { state: s, text: st.text }; C.runAction(s, 'owner', intent ? { text: st.text, source: 'text', intent } : { text: st.text, source: 'text' }); }
        else if (st.who === 'upi') C.runAction(s, 'upi', { text: st.text });
        else if (st.who === 'pay') {
          const r = C.payAmount(s, byName(st.cust).id, st.text);
          got = r && r.ok ? 'pay ' + rupee(r.amount) : 'amount refused' + (r && r.error ? ' (' + r.error + ')' : '');
          if (e.pay === false ? !!(r && r.ok) : !(r && r.ok && r.amount === e.pay)) why.push('pay amount');
        }
      } catch (err) { why.push('crashed: ' + (err && err.message)); got = 'CRASH ' + (err && err.message); }
      const reply = s.messages.slice(m).filter((x) => x.to === 'owner' && x.from === 'agent').map((x) => x.text).join(' | ');
      if (reply) out.reply = reply.slice(0, 300);
      if ((st.who === 'owner' || st.who === 'upi') && !reply && !got) why.push('no reply to the owner');
      const old = JSON.parse(before);
      const changed = old.filter((t) => { const x = s.txns.find((y) => y.id === t.id); return !x || x.amount !== t.amount || !!x.voided !== !!t.voided || x.custId !== t.custId || x.type !== t.type; });
      const fresh = s.txns.slice(n).filter((t) => !t.voided);
      const wrote = fresh.map((t) => [t.type === 'payment' || t.type === 'credit' ? t.type : t.type, nameOf(t.custId), Math.round(t.amount * 100) / 100]);
      if (st.who !== 'pay' && !got) got = show(wrote) + (changed.length ? ' + changed ' + changed.length + ' old entr' + (changed.length > 1 ? 'ies' : 'y') : '');
      if (changed.length) why.push('old entries changed');
      if (e.writes) {
        const want = e.writes.map((w) => w.join('|')).sort().join(','), have = wrote.map((w) => w.join('|')).sort().join(',');
        if (want !== have) why.push('wrong entries');
      }
      if (e.none && fresh.length) why.push('wrote when it should not');
      if (e.noExisting && fresh.some((t) => existing.has(t.custId))) why.push('wrote on an existing khata');
      if (e.balances) for (const k in e.balances) {
        const c = byName(k), b = c ? Math.round(C.balance(s, c.id)) : NaN;
        if (b !== e.balances[k]) why.push(k + ' baaki is ' + rupee(b));
        if (st.who === 'none') got = k + ' baaki ' + rupee(b);
      }
      actual.push(got);
      if (why.length) { out.pass = false; out.why.push(...why); }
    }
    out.actual = actual.join('  ⏎  ');
    return out;
  }
  function runCase(C, kase, today) {
    const g = walk(C, kase, today);
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }
  /** The same case with the model reading each owner message first; read's failure counts as the rules reading it. */
  async function runCaseAi(C, kase, today, read) {
    const g = walk(C, kase, today), by = [];
    let r = g.next(), ms = 0;
    while (!r.done) {
      let intent = null;
      try {
        intent = await read(r.value.state, r.value.text);
        if (intent && intent.ms != null) ms += intent.ms;
        by.push(intent && intent.provider ? 'ai' : 'rules');
      } catch (e) { by.push('rules'); }
      r = g.next(intent || undefined);
    }
    return Object.assign(r.value, { readBy: by, ms });
  }
  return { runCase, runCaseAi, describe };
});
