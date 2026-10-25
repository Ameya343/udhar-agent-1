// AI-generated test cases for the live test-run page (/test-run): the shop's own model (the Agent37 router, or
// LLM_BASE_URL first) writes a fresh batch of shopkeeper messages, and each one goes through the real owner pipeline
// (brain.understandOwner, AI first with the rules as checks, then the khata) on a throwaway Gupta demo shop. The live
// khata is never read or written.
//
// Nobody writes an expected answer for these messages, so a case is checked against rules that hold for ANY message:
//   no crash; the owner gets a reply; old entries stay as they were (unless the message is a fix / undo);
//   a question or an unclear message writes nothing; every amount written is a number in the message;
//   every khata written to has its name in the message; credit stays credit and payment stays payment.
// The generator also labels each message (kind, name, amount). Those labels come from a model, not a person, so a
// disagreement with them is shown as "label" and counted separately from a broken rule.
//
//   AI_TEST_MAX_CASES      default 20: the most cases one run may ask for (each case is one model call, plus one to write them)
//   AI_TEST_MAX_PER_HOUR   default 6: runs per hour for the whole instance (they spend the shop's model credits)
import C = require('../core/agent-core');
import { createBrain } from './brain';
import type { LlmOpts, ChatResult } from './llm';
import type { State } from '../core/types';

type Env = Record<string, string | undefined>;
export interface AiTestOpts { env?: Env; fetch?: LlmOpts['fetch']; today: () => string; now?: () => number }
export type Kind = 'credit' | 'payment' | 'query' | 'unclear' | 'fix' | 'other';
export interface GenCase { text: string; kind: Kind; name: string | null; amount: number | null }
export interface AiCaseResult {
  id: number; text: string; label: GenCase; pass: boolean; why: string[]; labelWhy: string[]; skipped: string[];
  readBy: string; ms: number | null; intent: string; wrote: string; reply: string; asked: boolean;
}
export interface AiRun {
  ok: boolean; error?: string; reason?: string;
  generator?: { provider: string; via: string; model: string; ms: number; asked: number; got: number };
  results?: AiCaseResult[]; pass?: number; fail?: number; labelDisagree?: number; aiRead?: number; ms?: number; calls?: number;
}

const KINDS: Kind[] = ['credit', 'payment', 'query', 'unclear', 'fix', 'other'];
const HONORIFIC = /^(ji|bhai|bhaiya|didi|di|aunty|uncle|kaka|kaku|bhau|sir|madam|saheb|sahab|seth|mama|mausi)$/;
// rupee amounts as words; when a message has these the "amount is in the message" rule cannot be checked by digits
const NUM_WORDS = /\b(ek|do|teen|char|chaar|paanch|panch|chhe|saat|aath|nau|das|bees|tees|chalis|pachas|pachaas|saath|sattar|assi|nabbe|sau|so|hazaar|hazar|hajar|dedh|dhai|adha|aadha|sava|saade|sade|lakh|hundred|thousand|five|ten|fifty)\b/i;
const via = (provider: string) => (provider === 'router' ? 'Agent37 LLM router' : provider === 'custom' ? 'LLM_BASE_URL (Agent37 router as fallback)' : provider);

/** The numbers written in a message, in rupees: "1,200" 1200, "2k" 2000, "1.5k" 1500, "₹300" 300. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of String(text).replace(/(\d),(?=\d)/g, '$1').matchAll(/(\d+(?:\.\d+)?)\s*(k\b)?/gi)) out.push(Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1) * 100) / 100);
  return out;
}
/** Whether a khata's name is in the message: any name word that is not "ji", "bhai"..., as typed or joined ("sharmaji"). */
function nameIn(name: string, text: string): boolean {
  const t = String(text).toLowerCase();
  const words = String(name).toLowerCase().split(/[^a-zऀ-ॿ]+/).filter((w) => w.length >= 3 && !HONORIFIC.test(w));
  return words.some((w) => t.includes(w));
}

/** The generator's reply, cleaned: up to `max` cases with a text and a known kind; anything else is dropped. */
function cleanCases(j: any, max: number): GenCase[] {
  const list = Array.isArray(j && j.cases) ? j.cases : [];
  const out: GenCase[] = [];
  for (const k of list) {
    if (!k || typeof k.text !== 'string') continue;
    const text = k.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const kind = String(k.kind || '').toLowerCase() as Kind;
    if (!text || KINDS.indexOf(kind) < 0) continue;
    const amount = typeof k.amount === 'number' && isFinite(k.amount) && k.amount > 0 ? k.amount : typeof k.amount === 'string' && +k.amount > 0 ? +k.amount : null;
    out.push({ text, kind, name: typeof k.name === 'string' && k.name.trim() ? k.name.trim().slice(0, 60) : null, amount });
    if (out.length >= max) break;
  }
  if (!out.length) throw new Error('no usable cases in the reply');
  return out;
}

function generatorMessages(state: State, n: number, seed: number) {
  const names = C.live(state).map((c) => c.name).join(', ');
  const system = 'You write TEST messages for a WhatsApp udhaar (credit) bookkeeping agent used by an Indian kirana shop owner. ' +
    'Write ' + n + ' different messages the SHOP OWNER might send to the agent, the way real owners type on WhatsApp: Hinglish in Latin letters mostly, some Hindi in Devanagari, typos, no punctuation, short forms (rs, 2k), amounts as words now and then (paanch sau, dedh hazaar).\n' +
    'Customers already in the khata: ' + names + '. Also use a few names NOT in the khata, and nicknames or half names of the ones that are.\n' +
    'Mix these kinds: credit (someone took goods or money on udhaar), payment (someone paid the shop back), query (asks a balance or the hisaab, no new entry), ' +
    'unclear (amount missing, name missing, two people, or a hedge like "shayad 500 tha"), fix (cancel or correct an earlier entry), other (greeting, stock, anything else). At least two unclear and two tricky ones.\n' +
    'For each message give: text; kind (one of credit, payment, query, unclear, fix, other); name = the customer the money is for, as written, or null; amount = rupees as a number, or null.\n' +
    'Answer with JSON only: {"cases":[{"text":"...","kind":"...","name":"...","amount":500}]}. Batch ' + seed + ': make this batch different from earlier ones.';
  return [{ role: 'system', content: system }, { role: 'user', content: 'Write the ' + n + ' messages now.' }];
}

function createAiTest(opts: AiTestOpts) {
  const env = opts.env || {};
  const now = opts.now || Date.now;
  const maxCases = Math.max(1, Math.min(50, +env.AI_TEST_MAX_CASES! || 20));
  const perHour = +env.AI_TEST_MAX_PER_HOUR! || 6;
  let shop: State = null!;
  // its own brain (and so its own provider stats and circuit breaker), reading the throwaway shop
  const brain = createBrain({ env, fetch: opts.fetch, getState: () => shop });
  const runs: number[] = [];
  let busy = false;

  /** One case on its own fresh demo shop, so no case sees another's entries. */
  async function runOne(id: number, k: GenCase): Promise<AiCaseResult> {
    shop = C.freshShop('gupta', opts.today());
    const s = shop;
    const before = JSON.stringify(s.txns), n = s.txns.length, m = s.messages.length;
    const r: AiCaseResult = { id, text: k.text, label: k, pass: true, why: [], labelWhy: [], skipped: [], readBy: 'rules', ms: null, intent: '', wrote: '', reply: '', asked: false };
    try {
      const intent = await brain.understandOwner(k.text);
      r.readBy = intent.provider ? via(intent.provider) : 'rules (AI did not answer)';
      r.ms = intent.ms != null ? intent.ms : null;
      r.intent = (intent.u && intent.u.intent) || intent.intent || '';
      C.runAction(s, 'owner', { text: k.text, source: 'text', intent });
    } catch (e: any) { r.why.push('crashed: ' + String(e && e.message).slice(0, 120)); }
    const name = (id: string) => { const c = s.customers.find((x) => x.id === id); return c ? c.name : id; };
    const fresh = s.txns.slice(n).filter((t) => !t.voided);
    const old = JSON.parse(before) as State['txns'];
    const changed = old.filter((t) => { const x = s.txns.find((y) => y.id === t.id); return !x || x.amount !== t.amount || !!x.voided !== !!t.voided || x.custId !== t.custId || x.type !== t.type; });
    r.wrote = fresh.map((t) => (t.type === 'payment' ? 'jama ' : t.type === 'credit' ? 'udhaar ' : t.type + ' ') + name(t.custId) + ' ₹' + Math.round(t.amount * 100) / 100).join(', ') || 'nothing written';
    if (changed.length) r.wrote += ' + changed ' + changed.length + ' old entr' + (changed.length > 1 ? 'ies' : 'y');
    r.reply = s.messages.slice(m).filter((x) => x.from === 'agent' && x.to === 'owner').map((x) => x.text).join(' | ').slice(0, 300);
    r.asked = !!s.pending;
    if (!r.reply && !r.why.length) r.why.push('no reply to the owner');
    if (changed.length && k.kind !== 'fix') r.why.push('old entries changed by a message that is not a fix');
    if ((k.kind === 'query' || k.kind === 'unclear') && fresh.length) r.why.push('wrote to the khata on a ' + k.kind + ' message without asking');
    const nums = numbersIn(k.text), words = NUM_WORDS.test(k.text);
    for (const t of fresh) {
      const amt = Math.round(t.amount * 100) / 100;
      // a bill of items adds up prices, so only a single number written must be one the owner typed
      if (nums.indexOf(amt) < 0) { if (words || nums.length > 1) r.skipped.push('₹' + amt + ' from words or a sum'); else r.why.push('₹' + amt + ' written but not in the message'); }
      if (/[ऀ-ॿ]/.test(k.text)) r.skipped.push('name check (Devanagari)');
      else if (!nameIn(name(t.custId), k.text)) r.why.push('wrote on ' + name(t.custId) + ', whose name is not in the message');
      if (k.kind === 'credit' && t.type === 'payment') r.why.push('udhaar written as jama');
      if (k.kind === 'payment' && t.type === 'credit') r.why.push('jama written as udhaar');
    }
    // against the generator's labels (a model's guess, not a person's): shown, not counted as a broken rule
    if ((k.kind === 'credit' || k.kind === 'payment') && !fresh.length && !r.asked) r.labelWhy.push('label says ' + k.kind + ', nothing written and nothing asked');
    if (k.amount != null) for (const t of fresh) if (Math.abs(t.amount - k.amount) > 0.5) r.labelWhy.push('label says ₹' + k.amount + ', wrote ₹' + Math.round(t.amount));
    r.pass = !r.why.length;
    return r;
  }

  async function run(count: unknown): Promise<AiRun> {
    if (!brain.llm.enabled) return { ok: false, error: 'no-model', reason: 'No model on this instance: AGENT37_LLM_PROXY_URL (set by Agent37) and LLM_BASE_URL are both unset, so the AI cannot write cases here. The fixed cases still run.' };
    if (busy) return { ok: false, error: 'busy', reason: 'An AI test run is already going. Try again in a minute.' };
    const t = now();
    while (runs.length && t - runs[0] > 3600e3) runs.shift();
    if (runs.length >= perHour) return { ok: false, error: 'limit', reason: 'This instance already ran ' + perHour + ' AI test runs in the last hour (they spend the shop\'s model credits). Try again later.' };
    const n = Math.max(1, Math.min(maxCases, Math.floor(+(count as number)) || 10));
    busy = true; runs.push(t);
    const calls0 = brain.llm.stats.calls;
    try {
      shop = C.freshShop('gupta', opts.today());
      let gen: ChatResult<GenCase[]>;
      try {
        gen = await brain.llm.chatJson(generatorMessages(shop, n, Math.floor(Math.random() * 1e6)), { maxTokens: 120 + 90 * n, timeoutMs: 30000, temperature: 0.9, validate: (j) => cleanCases(j, n) });
      } catch (e: any) { return { ok: false, error: 'generator', reason: 'The model did not write usable cases: ' + String(e && e.message).slice(0, 160) }; }
      const results: AiCaseResult[] = [];
      for (let i = 0; i < gen.value.length; i++) results.push(await runOne(i + 1, gen.value[i]));
      const pass = results.filter((r) => r.pass).length;
      return {
        ok: true, generator: { provider: gen.provider, via: via(gen.provider), model: gen.model, ms: gen.ms, asked: n, got: gen.value.length },
        results, pass, fail: results.length - pass, labelDisagree: results.filter((r) => r.labelWhy.length).length,
        aiRead: results.filter((r) => !/^rules/.test(r.readBy)).length, ms: now() - t, calls: brain.llm.stats.calls - calls0
      };
    } finally { busy = false; }
  }

  return { run, enabled: brain.llm.enabled, describe: brain.llm.describe, maxCases };
}

export { createAiTest, numbersIn, nameIn, cleanCases };
