// Accuracy, cost and speed of the understanding layer on generated checker messages with known expected entries.
// Dry run: every message runs on its own in-memory copy of the demo shop; nothing is saved or sent.
//
//   node dist-server/scripts/eval-llm.js [--mode rules-only|llm-alone|full|all] [--n 1500] [--seed 7]
//        [--out /mnt/project-files/hackyard/eval] [--concurrency 4] [--limit 0]
//
// Modes:
//   rules-only  the offline rule parser alone (no model), through the khata exactly as the shop runs it
//   llm-alone   the model's raw parsed JSON (intent, person, amount, method) compared with the expected entry, no safety rules
//   full        the model's reading through the khata's safety rules (amount must be in the message, payment words, ...)
// The model is any OpenAI-compatible endpoint: LLM_BASE_URL (…/v1), LLM_API_KEY, LLM_MODEL. Optional cost figures:
// LLM_PRICE_IN_PER_M and LLM_PRICE_OUT_PER_M (USD per million tokens; default 0, so cost shows as 0 unless set).
// Results go to <out>/eval-llm.json (every mode run so far; the file is re-read and merged, never blindly overwritten)
// and <out>/eval-llm.md (the table for all modes in that file).
import fs = require('fs');
import path = require('path');
import C = require('../core/agent-core');
import U = require('../core/understand');
import { extractJson } from '../server/llm';
import type { State, Txn, OwnerIntent, CustomerIntent } from '../core/types';

type Mode = 'rules-only' | 'llm-alone' | 'full';
type Kind = 'credit' | 'payment' | 'claim' | 'none';
/** One generated checker message and the entry it must produce (or none). */
interface Case { id: number; cat: string; role: 'owner' | 'customer'; custId?: string; text: string; want: { kind: Kind; custId?: string; amount?: number } }
type Verdict = 'correct' | 'wrong' | 'ask' | 'miss';
interface Row { id: number; cat: string; verdict: Verdict; asked: boolean; got: string; ms: number | null; tin: number; tout: number }
interface Usage { prompt_tokens?: number; completion_tokens?: number }

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TODAY = '2026-10-20';
const OWNER_MSGS_PER_DAY = 60, DAYS = 30;

// ------------------------------------------------------------------ generators (the stress harness's names, amounts, phrasings)
let seed = +arg('--seed', '7');
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const KNOWN: Record<string, string[]> = {
  C001: ['Sharma ji', 'sharma', 'sharmaji', 'शर्मा जी', 'SHARMA JI'], C002: ['Meena didi', 'meena', 'मीना दीदी'], C003: ['Pappu', 'pappu', 'पप्पू'],
  C004: ['Iqbal bhai', 'iqbal', 'इकबाल भाई'], C005: ['Verma ji', 'verma', 'वर्मा जी'], C006: ['Kavita aunty', 'kavita'], C008: ['Deshmukh kaka', 'deshmukh'],
  C009: ['Patil bhau', 'patil'], C011: ['Wankhede ji', 'wankhede'], C014: ['Ansari bhai', 'ansari'], C016: ['Gawande ji', 'gawande'], C017: ['Thakre sir', 'thakre']
};
const KIDS = Object.keys(KNOWN);
const UNKNOWN = ['Kallu bhai', 'Bunty', 'Golu', 'Chintu', 'Tinku', 'Munna bhai', 'Sonu', 'Bablu', 'Guddu', 'Lalit', 'Kamble ji', 'Mehta ji', 'Pawar saheb'];
const DEV = (n: number) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[+d]);
function amt(): [number, string] {
  const a = pick([40, 60, 85, 120, 150, 200, 240, 300, 340, 450, 500, 650, 800, 1000, 1250, 1500, 2200, 3000]);
  const f = pick(['d', 'd', 'd', 'rs', 'r', 'comma', 'dev']);
  return [a, f === 'rs' ? 'Rs ' + a : f === 'r' ? '₹' + a : f === 'comma' && a >= 1000 ? a.toLocaleString('en-IN') : f === 'dev' ? DEV(a) : String(a)];
}
const CREDIT = ['{n} ne {a} ka saman liya', '{n} {a} udhaar likho', '{n} ka {a} likh do', '{n} ne {a} ka maal liya, kal denge', '{n} ने {a} का सामान लिया', '{n} took goods worth {a}', '{n} {a} khate mein'];
const PAYMENT = ['{n} ne {a} diye', '{n} ne {a} jama kiye', '{n} {a} jama', '{n} ne {a} cash diye', '{n} paid {a}', '{n} ने {a} जमा किए', '{n} se {a} mil gaye'];
const LIST_ITEMS: [string, number][] = [['2 kilo aata', 80], ['doodh', 30], ['1 kilo cheeni', 45], ['2 maggi', 24], ['tel 1 litre', 180], ['sabun', 40], ['Parle-G', 10]];
const OWNER_NONE = ['aaj bahut garmi hai', 'hello', 'kal dukaan band rahegi', 'aaj ka hisaab', 'kiska kitna baaki hai', 'good morning', 'chai pi lo', 'ok', 'theek hai bhai', 'aaj kitna wasool hua'];
const CUST_CASH = ['maine {a} cash de diye', 'bhaiya {a} de diye the kal', 'मैंने {a} दे दिए', '{a} cash diya hai', 'maine {a} de diye'];
const CUST_UPI = ['maine {a} gpay kar diya', '{a} bhej diye phonepe se', 'I paid {a} by UPI'];
const CUST_NONE = ['Old is gold', 'hi', 'kitna baaki hai', 'kal dunga', 'Shanivar ko dunga', 'suna kya?', '😂😂', 'bhaiya hisaab bhejo', 'ok ji'];
const fill = (t: string, n: string, a: string) => t.replace('{n}', n).replace('{a}', a);

function generate(n: number): Case[] {
  const out: Case[] = [];
  for (let id = 1; out.length < n; id++) {
    const r = rnd();
    if (r < 0.25) { const c = pick(KIDS); const [a, as] = amt(); out.push({ id, cat: 'owner-credit', role: 'owner', text: fill(pick(CREDIT), pick(KNOWN[c]), as), want: { kind: 'credit', custId: c, amount: a } }); }
    else if (r < 0.47) { const c = pick(KIDS); const [a, as] = amt(); out.push({ id, cat: 'owner-payment', role: 'owner', text: fill(pick(PAYMENT), pick(KNOWN[c]), as), want: { kind: 'payment', custId: c, amount: a } }); }
    else if (r < 0.57) {
      const c = pick(KIDS); const its = LIST_ITEMS.slice().sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 2));
      out.push({ id, cat: 'owner-list', role: 'owner', text: pick(['{n} ki list: ', '{n} ka saman: ']).replace('{n}', KNOWN[c][0]) + its.map(([t, p]) => t + ' ' + p).join(', '), want: { kind: 'credit', custId: c, amount: its.reduce((s, x) => s + x[1], 0) } });
    }
    else if (r < 0.64) { const [, as] = amt(); out.push({ id, cat: 'owner-unknown-name', role: 'owner', text: fill(pick(CREDIT), pick(UNKNOWN), as), want: { kind: 'none' } }); }
    else if (r < 0.72) out.push({ id, cat: 'owner-chat', role: 'owner', text: pick(OWNER_NONE), want: { kind: 'none' } });
    else if (r < 0.84) { const c = pick(KIDS); const [a, as] = amt(); out.push({ id, cat: 'customer-cash', role: 'customer', custId: c, text: pick(CUST_CASH).replace('{a}', as), want: { kind: 'claim', custId: c, amount: a } }); }
    else if (r < 0.9) { const c = pick(KIDS); const [, as] = amt(); out.push({ id, cat: 'customer-upi', role: 'customer', custId: c, text: pick(CUST_UPI).replace('{a}', as), want: { kind: 'none' } }); }
    else { const c = pick(KIDS); out.push({ id, cat: 'customer-chat', role: 'customer', custId: c, text: pick(CUST_NONE), want: { kind: 'none' } }); }
  }
  return out;
}

// ------------------------------------------------------------------ the model
const env = process.env;
const base = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
const model = env.LLM_MODEL || '';
async function callModel(messages: { role: string; content: string }[]): Promise<{ json: unknown; ms: number; tin: number; tout: number }> {
  const t0 = Date.now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), +(env.LLM_TIMEOUT_MS || 30000));
      const r = await fetch(base + '/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: Object.assign({ 'content-type': 'application/json' }, env.LLM_API_KEY ? { authorization: 'Bearer ' + env.LLM_API_KEY } : {}) as Record<string, string>,
        body: JSON.stringify(Object.assign({ model, messages, temperature: 0, max_tokens: 500 }, env.LLM_JSON_MODE === '0' ? {} : { response_format: { type: 'json_object' } }))
      }).finally(() => clearTimeout(timer));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: Usage };
      const content = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
      return { json: extractJson(content), ms: Date.now() - t0, tin: (j.usage && j.usage.prompt_tokens) || 0, tout: (j.usage && j.usage.completion_tokens) || 0 };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ------------------------------------------------------------------ one message, one mode
const shop0: State = (() => { const s = C.freshShop('gupta', TODAY); for (const c of s.customers) if (c.phone) c.wa = true; return s; })();
const clone = (): State => JSON.parse(JSON.stringify(shop0));
const existing = new Set(shop0.customers.map((c) => c.id));

/** What the khata did with the message: the entries written to existing khatas, new pending claims, and whether the agent asked. */
function effects(s: State, nT: number, nK: number, nM: number) {
  const tx: Txn[] = s.txns.slice(nT);
  const claims = C.pendingClaims(s).slice(nK);
  const toOwner = s.messages.slice(nM).filter((m) => m.from === 'agent' && m.to === 'owner');
  const asked = !!s.pending || toOwner.some((m) => /\?/.test(m.text));
  return { tx, claims, asked };
}
function judge(k: Case, tx: { kind: string; custId: string; amount: number }[], asked: boolean): Verdict {
  const onExisting = tx.filter((t) => existing.has(t.custId));
  if (k.want.kind === 'none') return onExisting.length ? 'wrong' : asked ? 'ask' : 'correct';
  if (!tx.length) return asked ? 'ask' : 'miss';
  const ok = tx.length === 1 && tx[0].kind === k.want.kind && tx[0].custId === k.want.custId && tx[0].amount === k.want.amount;
  return ok ? 'correct' : 'wrong';
}
const label = (tx: { kind: string; custId: string; amount: number }[]) => tx.map((t) => t.kind + ' ' + t.custId + ' ' + t.amount).join('; ') || '-';

async function runOne(k: Case, mode: Mode): Promise<Row> {
  const s = clone();
  const nT = s.txns.length, nK = C.pendingClaims(s).length, nM = s.messages.length;
  let ms: number | null = null, tin = 0, tout = 0;
  const cust = k.custId ? s.customers.find((c) => c.id === k.custId)! : null;
  // the same gates the live shop uses before asking a model (server/brain.ts)
  const skipModel = mode === 'rules-only' || (k.role === 'owner'
    ? (C.parseOwnerMessage(k.text, s.today).intent === 'choice' || C.looksLikeUpiSms(k.text) || C.looksLikeCounter(k.text))
    : !!C.customerPrefilter(k.text));
  let u: ReturnType<typeof U.normalize> | null = null;
  if (!skipModel) {
    try {
      const msgs = k.role === 'owner' ? U.ownerMessages(s, k.text) : U.customerMessages(s, cust!, k.text, C.customerContext(s, cust!, 5));
      const r = await callModel(msgs);
      ms = r.ms; tin = r.tin; tout = r.tout;
      u = U.normalize(r.json, k.role);
    } catch (e) { u = null; }
  }
  if (mode === 'llm-alone') {
    // the raw reading, no safety rules: intent + person + amount (+ method) as the entry the model asked for
    let tx: { kind: string; custId: string; amount: number }[] = [];
    let asked = false;
    if (u) {
      asked = !!u.ask;
      if (k.role === 'owner' && (u.intent === 'udhaar' || u.intent === 'list' || u.intent === 'jama')) {
        const key = C.intentFromLlm({ intent: 'credit', name: u.person, amount: 0 }, '').nameKey;
        const m = C.findCustomers(s, key).filter((c) => !c.removed);
        const amount = u.amount || u.items.reduce((a, x) => a + (x.price || 0), 0);
        if (m.length === 1 && amount > 0) tx = [{ kind: u.intent === 'jama' ? 'payment' : 'credit', custId: m[0].id, amount }];
        else if (m.length !== 1) tx = [{ kind: 'new', custId: 'NEW', amount }];
      } else if (k.role === 'customer' && u.intent === 'payment_claim' && u.method !== 'upi' && u.amount) tx = [{ kind: 'claim', custId: k.custId!, amount: u.amount }];
    }
    return { id: k.id, cat: k.cat, verdict: u ? judge(k, tx, asked) : 'miss', asked, got: u ? u.intent + ' ' + label(tx) : 'no answer', ms, tin, tout };
  }
  try {
    if (k.role === 'owner') {
      const intent: OwnerIntent | undefined = u ? U.toOwnerIntent(u, k.text) : undefined;
      C.runAction(s, 'owner', Object.assign({ text: k.text, source: 'text' }, intent ? { intent } : {}));
    } else {
      const intent: CustomerIntent | null = u ? U.toCustomerIntent(u, k.text) : null;
      C.runAction(s, 'customer', Object.assign({ custId: k.custId, text: k.text, now: Date.UTC(2026, 9, 20, 8) }, intent ? { intent } : {}));
    }
  } catch (e) { return { id: k.id, cat: k.cat, verdict: 'wrong', asked: false, got: 'exception ' + String((e as Error).message).slice(0, 60), ms, tin, tout }; }
  const ef = effects(s, nT, nK, nM);
  const tx = ef.tx.map((t): { kind: string; custId: string; amount: number } => ({ kind: t.type, custId: t.custId, amount: t.amount })).concat(ef.claims.map((c) => ({ kind: 'claim', custId: c.custId, amount: c.amount })));
  return { id: k.id, cat: k.cat, verdict: judge(k, tx, ef.asked), asked: ef.asked, got: label(tx), ms, tin, tout };
}

// ------------------------------------------------------------------ report
const pctl = (a: number[], p: number) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function summarize(mode: Mode, rows: Row[]) {
  const n = rows.length, per1k = (x: number) => +(1000 * x / n).toFixed(1);
  const lat = rows.map((r) => r.ms).filter((x): x is number => x != null);
  const calls = lat.length;
  const tin = rows.reduce((a, r) => a + r.tin, 0), tout = rows.reduce((a, r) => a + r.tout, 0);
  const pin = +(env.LLM_PRICE_IN_PER_M || 0), pout = +(env.LLM_PRICE_OUT_PER_M || 0);
  const costMsg = n ? (tin * pin + tout * pout) / 1e6 / n : 0;
  const byCat: Record<string, { n: number; correct: number; wrong: number; ask: number }> = {};
  for (const r of rows) { const b = byCat[r.cat] = byCat[r.cat] || { n: 0, correct: 0, wrong: 0, ask: 0 }; b.n++; if (r.verdict === 'correct') b.correct++; if (r.verdict === 'wrong') b.wrong++; if (r.asked) b.ask++; }
  return {
    mode, at: new Date().toISOString(), model: mode === 'rules-only' ? null : model || null, endpoint: mode === 'rules-only' ? null : base.replace(/\/\/[^/@]*@/, '//') || null,
    n, accuracyPct: +(100 * rows.filter((r) => r.verdict === 'correct').length / n).toFixed(1),
    wrongPer1000: per1k(rows.filter((r) => r.verdict === 'wrong').length), asksPer1000: per1k(rows.filter((r) => r.asked).length), missPer1000: per1k(rows.filter((r) => r.verdict === 'miss').length),
    modelCalls: calls, p50LatencyS: lat.length ? +(pctl(lat, 0.5)! / 1000).toFixed(2) : 0, p95LatencyS: lat.length ? +(pctl(lat, 0.95)! / 1000).toFixed(2) : 0,
    tokensInPerMsg: n ? +(tin / n).toFixed(1) : 0, tokensOutPerMsg: n ? +(tout / n).toFixed(1) : 0,
    priceInPerM: pin, priceOutPerM: pout, costPerMsgUsd: +costMsg.toFixed(6), costPerShopMonthUsd: +(costMsg * OWNER_MSGS_PER_DAY * DAYS).toFixed(4),
    byCategory: byCat,
    wrongExamples: rows.filter((r) => r.verdict === 'wrong').slice(0, 25)
  };
}
type Summary = ReturnType<typeof summarize>;
function markdown(runs: Record<string, Summary>, cases: Case[]): string {
  const order = ['llm-alone', 'full', 'rules-only'].filter((m) => runs[m]);
  const lines = ['# Udhaar Agent: understanding-layer eval', '',
    'Generated checker messages with known expected entries (`scripts/eval-llm.ts`, seed ' + arg('--seed', '7') + '). Each message runs on its own copy of the demo shop; nothing is saved or sent.',
    'Wrong = an entry written that is not the expected one (wrong person, amount or type, or any entry where none was expected). Ask = the agent asked back. Cost per shop/month assumes ' + OWNER_MSGS_PER_DAY + ' owner messages a day for ' + DAYS + ' days.', '',
    '| Mode | Model | n | Accuracy % | Wrong / 1,000 | Asks / 1,000 | p50 s | p95 s | Tokens in/out per msg | Cost per msg (USD) | Cost per shop/month (USD) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const m of order) {
    const r = runs[m];
    lines.push('| ' + [m, r.model || '-', r.n, r.accuracyPct, r.wrongPer1000, r.asksPer1000, r.p50LatencyS, r.p95LatencyS, r.tokensInPerMsg + ' / ' + r.tokensOutPerMsg, r.costPerMsgUsd, r.costPerShopMonthUsd].join(' | ') + ' |');
  }
  lines.push('', '## By category', '');
  for (const m of order) {
    lines.push('### ' + m + ' (' + runs[m].at.slice(0, 16).replace('T', ' ') + ' UTC)', '', '| Category | n | Correct % | Wrong | Asks |', '|---|---:|---:|---:|---:|');
    for (const [c, b] of Object.entries(runs[m].byCategory)) lines.push('| ' + c + ' | ' + b.n + ' | ' + (100 * b.correct / b.n).toFixed(1) + ' | ' + b.wrong + ' | ' + b.ask + ' |');
    lines.push('');
  }
  lines.push('Sample messages: ' + cases.slice(0, 6).map((k) => '`' + k.text + '`').join(', ') + '.', '');
  return lines.join('\n');
}

async function main() {
  const n = Math.max(1000, Math.min(2000, +arg('--n', '1500')));
  const want = arg('--mode', 'rules-only');
  const modes: Mode[] = want === 'all' ? ['rules-only', 'llm-alone', 'full'] : [want as Mode];
  for (const m of modes) if (['rules-only', 'llm-alone', 'full'].indexOf(m) < 0) throw new Error('unknown mode ' + m);
  if (modes.some((m) => m !== 'rules-only') && (!base || !model)) throw new Error('llm-alone and full need LLM_BASE_URL and LLM_MODEL (and LLM_API_KEY if the endpoint wants one)');
  const cases = generate(n);
  const limit = +arg('--limit', '0');
  const run = limit > 0 ? cases.slice(0, limit) : cases;
  const outDir = arg('--out', '/mnt/project-files/hackyard/eval');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'eval-llm.json');
  for (const mode of modes) {
    const rows: Row[] = new Array(run.length);
    const conc = mode === 'rules-only' ? 1 : Math.max(1, +arg('--concurrency', '4'));
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < run.length) { const i = next++; rows[i] = await runOne(run[i], mode); if (++done % 100 === 0) process.stderr.write(mode + ' ' + done + '/' + run.length + '\n'); }
    }));
    const sum = summarize(mode, rows);
    // re-read right before writing: other modes (or another run) may have written meanwhile
    let all: { runs: Record<string, Summary> } = { runs: {} };
    try { all = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); if (!all || typeof all.runs !== 'object') all = { runs: {} }; } catch (e) { all = { runs: {} }; }
    all.runs[mode] = sum;
    fs.writeFileSync(jsonPath, JSON.stringify(all, null, 1));
    fs.writeFileSync(path.join(outDir, 'eval-llm.md'), markdown(all.runs, cases));
    const { byCategory, wrongExamples, ...head } = sum;
    console.log(JSON.stringify(head));
    void byCategory; void wrongExamples;
  }
  console.log('wrote ' + jsonPath + ' and eval-llm.md');
}
if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
export { generate, runOne, summarize, markdown };
