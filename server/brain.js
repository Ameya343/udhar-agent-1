// What the shop's AI does with one message: understand it (core/understand.js prompts, server/llm.js provider chain),
// and put the agent's replies to a customer into that customer's language. Every step has a rules fallback, so the
// shop keeps working with no model at all.
'use strict';
const C = require('../core/agent-core.js');
const U = require('../core/understand.js');
const { createLlm } = require('./llm.js');

function createBrain(opts) {
  const env = opts.env || {};
  const getState = opts.getState;
  const llm = createLlm({ env, fetch: opts.fetch });
  const cache = new Map(); // lang + text -> translation; menus and receipts repeat a lot

  /** The owner's message. Answers to the agent's own questions (a number, a rate, haan / nahi) and UPI SMS keep their exact parsers. */
  async function understandOwner(text, o) {
    o = o || {};
    const state = getState();
    const rules = C.parseOwnerMessage(text, state.today);
    const answering = state.pending || C.orderRateAnswer(state, text) || (C.shortAnswer(text) && ((state.ownerAsks || []).length || C.pendingClaims(state).length));
    if (!llm.enabled || rules.intent === 'choice' || answering || C.looksLikeUpiSms(text) || C.looksLikeCounter(text)) return rules;
    try {
      const r = await llm.chatJson(U.ownerMessages(state, o.heard || text), { maxTokens: 500, validate: (j) => U.normalize(j, 'owner') });
      const oi = U.toOwnerIntent(r.value, text);
      oi.provider = r.provider; oi.ms = r.ms; oi.u = r.value;
      return oi;
    } catch (e) { return rules; }
  }

  /** A customer's message. Null means "the strict rules decide" (emoji, abuse and opt-out never reach the model). */
  async function understandCustomer(text, custId, o) {
    o = o || {};
    const state = getState();
    const c = state.customers.find((x) => x.id === custId);
    if (!llm.enabled || !c || c.removed || c.optedOut || C.customerPrefilter(text)) return null;
    const asking = (state.orders || []).filter((x) => x.custId === c.id && x.status === 'ask').pop();
    const open = (state.orders || []).filter((x) => x.custId === c.id && x.date === state.today && (x.status === 'ask' || x.status === 'owner')).pop();
    const ctx = Object.assign(C.customerContext(state, c, 5), {
      asking: asking ? 'Udhaar mein likhein? Haan (khate mein) ya Nahi (cash denge)' : null,
      order: open ? open.lines.map((l) => l.name).join(', ') : null
    }); // the last messages both ways, an open "galat", the balance and last entries: a reply is read in its conversation
    try {
      const r = await llm.chatJson(U.customerMessages(state, c, o.heard || text, ctx), { maxTokens: 500, validate: (j) => U.normalize(j, 'customer') });
      const ci = U.toCustomerIntent(r.value, text);
      if (!ci) return null;
      ci.lang = U.replyLang(ci.lang, o.source);
      ci.provider = r.provider; ci.ms = r.ms; ci.u = r.value;
      return ci;
    } catch (e) { return null; }
  }

  /** One message in another language; the Hinglish original when the model fails or changes a number. */
  async function translate(text, lang) {
    if (!llm.enabled || !U.needsTranslation(lang) || !/[a-z]/i.test(text)) return null;
    const key = lang + '\n' + text;
    if (cache.has(key)) return cache.get(key);
    try {
      const r = await llm.chatJson(U.translateMessages(text, lang), { maxTokens: 700, validate: (j) => U.checkTranslation(text, j) });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      cache.set(key, r.value);
      return r.value;
    } catch (e) { return null; }
  }

  /** Every agent message to a customer since index `from`, in that customer's language (the original is kept as textOrig). */
  async function translateOut(state, from) {
    const jobs = [];
    for (const m of state.messages.slice(from)) {
      if (m.from !== 'agent' || m.to === 'owner' || m.textOrig) continue;
      const c = state.customers.find((x) => x.id === m.to);
      if (!c || !U.needsTranslation(c.lang)) continue;
      jobs.push(translate(m.text, c.lang).then((t) => { if (t) { m.textOrig = m.text; m.text = t; m.lang = c.lang; } }));
    }
    await Promise.all(jobs);
  }

  return { llm, understandOwner, understandCustomer, translate, translateOut };
}

module.exports = { createBrain };
