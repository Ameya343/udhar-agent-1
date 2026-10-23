// Accuracy of the old regex rules vs the AI "understand" step on test/eval/messages.json, through the same code
// the live shop runs (server/brain.js). Dry run: the khata is read once into memory, nothing is written, nothing sent.
//
//   node scripts/eval-understand.js [--khata /home/node/data/gupta.json] [--samples] [--json out.json]
// The model chain comes from the environment exactly as on the server (LLM_BASE_URL / LLM_MODEL / AGENT37_LLM_PROXY_URL ...).
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../core/agent-core.js');
const U = require('../core/understand.js');
const { createBrain } = require('../server/brain.js');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const khata = arg('--khata');
const base = khata ? JSON.parse(fs.readFileSync(khata, 'utf8')) : C.freshShop('gupta', new Date().toISOString().slice(0, 10));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/eval/messages.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));

const fewShot = new Set(U.customerShots(base.today).concat(U.ownerShots(base.today)).map((s) => s[0]));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-෿]+/g, ' ');
const itemsOk = (want, got) => want.every((alts) => alts.split('|').some((a) => got.some((g) => norm(g).includes(norm(a).trim()))));
const relOf = (r) => (typeof r.relevant === 'boolean' ? r.relevant : ['chitchat', 'abuse', 'greeting', 'unknown'].indexOf(r.intent) < 0);

async function main() {
  const state = clone();
  const brain = createBrain({ env: process.env, getState: () => state });
  if (!brain.llm.enabled) console.log('No model configured: only the rules are measured.');
  const cust = state.customers.find((c) => !c.guest && !c.removed && !c.optedOut) || C.createState().customers[0];
  const rows = [];
  for (const k of cases) {
    const old = U.rulesUnderstand(state, k.role, k.text, cust);
    let neu, ms = null, provider = 'rules';
    if (k.role === 'customer') {
      const pre = C.customerPrefilter(k.text);
      const ci = pre ? null : await brain.understandCustomer(k.text, cust.id, { source: 'text' });
      if (pre) neu = old; // emoji, abuse and opt-out never reach the model, on the live shop too
      else if (ci && ci.u) {
        // the khata's safety rules can change the AI's intent (a payment without payment words is a question)
        const intent = ci.intent === 'question' && ci.u.intent === 'payment_claim' ? 'question' : ci.u.intent;
        neu = { lang: ci.u.lang, english: ci.u.english, relevant: ci.u.relevant, intent, items: ci.u.items, amount: ci.amount };
        ms = ci.ms; provider = ci.provider;
      } else neu = old;
    } else {
      const oi = await brain.understandOwner(k.text, {});
      if (oi.u) { neu = { lang: oi.u.lang, english: oi.u.english, relevant: oi.u.relevant, intent: oi.u.intent, items: oi.u.items, amount: oi.amount }; ms = oi.ms; provider = oi.provider; }
      else neu = old;
    }
    const score = (r) => ({
      intent: k.intent.indexOf(r.intent) >= 0,
      relevant: typeof k.relevant === 'boolean' ? relOf(r) === k.relevant : null,
      items: k.items.length ? itemsOk(k.items, (r.items || []).map((x) => x.name)) : null,
      lang: r.lang === k.lang || (k.lang === 'hinglish' && r.lang === 'hi' && !/[ऀ-ॿ]/.test(k.text))
    });
    rows.push({ id: k.id, role: k.role, lang: k.lang, src: k.src, seen: fewShot.has(k.text), text: k.text, want: k.intent.join('|'), old: { got: old.intent, ...score(old) }, neu: { got: neu.intent, english: neu.english, ms, provider, items: (neu.items || []).map((x) => x.name), ...score(neu) } });
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  const pct = (a) => (a.length ? Math.round(100 * a.filter(Boolean).length / a.length) + '% (' + a.filter(Boolean).length + '/' + a.length + ')' : '-');
  const report = (label, sel) => {
    const r = rows.filter(sel);
    const m = (side, f) => pct(r.map((x) => x[side][f]).filter((v) => v !== null));
    console.log(label.padEnd(26) + ' n=' + String(r.length).padEnd(3) + ' intent old ' + m('old', 'intent').padEnd(13) + ' new ' + m('neu', 'intent').padEnd(13) +
      ' | relevant old ' + m('old', 'relevant').padEnd(13) + ' new ' + m('neu', 'relevant').padEnd(13) + ' | items old ' + m('old', 'items').padEnd(11) + ' new ' + m('neu', 'items'));
  };
  console.log('Model chain: ' + brain.llm.describe() + ' -> rules');
  report('ALL', () => true);
  report('  unseen (not few-shot)', (x) => !x.seen);
  report('  real messages', (x) => x.src === 'real');
  report('  customer', (x) => x.role === 'customer');
  report('  owner', (x) => x.role === 'owner');
  for (const l of [...new Set(rows.map((x) => x.lang))]) report('  lang ' + l, (x) => x.lang === l);
  const lat = rows.map((x) => x.neu.ms).filter((v) => v != null).sort((a, b) => a - b);
  const med = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  console.log('AI calls: ' + lat.length + ', median latency ' + med + ' ms, p90 ' + (lat.length ? lat[Math.floor(lat.length * 0.9)] : null) + ' ms; language detected right: ' + pct(rows.filter((x) => x.neu.ms != null).map((x) => x.neu.lang)));
  console.log('Providers: ' + JSON.stringify(brain.llm.health().providers));
  console.log('\nMisses (new path; old rules in brackets):');
  for (const x of rows) if (!x.neu.intent || x.neu.items === false || x.neu.relevant === false) console.log(' ' + x.id + ' [' + x.lang + '] want ' + x.want + ' got ' + x.neu.got + (x.neu.items === false ? ' items ' + JSON.stringify(x.neu.items) : '') + (x.neu.relevant === false ? ' (relevance wrong)' : '') + ' [rules: ' + x.old.got + (x.old.intent ? ' ok' : '') + '] :: ' + x.text.slice(0, 70));

  if (process.argv.includes('--samples')) {
    console.log('\nSample replies (in-memory copy, nothing saved or sent):');
    for (const [lang, text] of [['hinglish', 'bhaiya 2 kilo aata aur ek Parle-G bhej dena'], ['mr', 'मला दोन किलो साखर आणि एक पाकीट दूध पाहिजे'], ['hi', 'मेरा कितना बाकी है?'], ['en', 'Please send 2 packets of milk and some Maggi']]) {
      const st = clone();
      const b2 = createBrain({ env: process.env, getState: () => st });
      const c = st.customers.find((x) => !x.guest && !x.removed && !x.optedOut);
      const ci = await b2.understandCustomer(text, c.id, { source: 'text' });
      const from = st.messages.length;
      C.runAction(st, 'customer', { custId: c.id, text, intent: ci });
      await b2.translateOut(st, from);
      for (const m of st.messages.slice(from)) if (m.from === 'agent') console.log('[' + lang + '] to ' + (m.to === 'owner' ? 'owner' : 'customer') + ': ' + m.text.replace(/\n/g, ' / '));
    }
  }
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
