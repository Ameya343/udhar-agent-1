// The 19 Oct 2026 conversation with Krish Singh, replayed (mock AI): an order on udhaar, the owner sets the daal rate,
// the bill says the true balance (an advance, not a bare ₹0), Krish says "Galat", then "Mera udhar bs 40 rupaye hai".
// That message must be read in its conversation and reach the owner as a dispute, never the generic menu.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { createServer } = require('../dist-server/server/server.js');

const TODAY = '2026-10-19';
const u = (o) => Object.assign({ lang: 'hinglish', english: '', relevant: true, reason: '', intent: 'chitchat', items: [], amount: null, person: '', phone: '', due_date: '', method: '', canon: '', confidence: 0.9, ask: '' }, o);
const reply = (content, status) => new Response(status ? '{}' : JSON.stringify({ model: 'mock-model', choices: [{ message: { content: JSON.stringify(content) } }] }), { status: status || 200 });
const ORDER = 'mujhe ek kilo aata aur do kg daal chaahie.';
const CLAIM = 'Mera udhar bs 40 rupaye hai';
const MENU = /Aap aise likh sakte/;

function mockAi(down) {
  const prompts = [];
  const f = async (url, init) => {
    const b = JSON.parse(init.body);
    const sys = b.messages[0].content, user = b.messages[b.messages.length - 1].content;
    if (/You translate/.test(sys)) return reply({ text: user });
    if (!/CUSTOMER/.test(sys)) return reply(u({ intent: 'unknown' }));
    prompts.push({ sys, user });
    if (down) return reply(null, 503);
    if (user === ORDER) return reply(u({ intent: 'order', english: 'I need 1 kg flour and 2 kg lentils', items: [{ name: 'aata', qty: 1, unit: 'kg', price: null }, { name: 'daal', qty: 2, unit: 'kg', price: null }] }));
    if (user === CLAIM) return reply(u({ intent: 'balance_dispute', amount: 40, english: 'My udhaar is only 40 rupees', reason: 'disputes the total' }));
    if (/kya haal/.test(user)) return reply(u({ intent: 'chitchat', relevant: false, english: 'How are you' }));
    return reply(u({ intent: 'question', english: 'When will the goods come?' }));
  };
  f.prompts = prompts;
  return f;
}
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))); }
async function act(base, action, args) {
  const r = await globalThis.fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
  return r.json();
}

/** Krish as on the live khata: a ₹200 credit voided after his "galat", the ₹200 cash he paid for it still counted (₹200 advance). */
function setup(st) {
  st.customers.push({ id: 'C099', name: 'Krish Singh', key: 'krish singh', phone: '9022099109', vpas: [], dueDate: null, lastReminder: null, reminderLevel: 0, createdAt: '2026-10-18', wa: true, lang: 'hinglish' });
  st.txns.push({ id: 'T901', custId: 'C099', type: 'credit', amount: 200, items: 'saman', date: '2026-10-18', voided: true, voidReason: 'customer ne galat bataya, dukaandaar ne maana' });
  st.txns.push({ id: 'T902', custId: 'C099', type: 'payment', amount: 200, date: '2026-10-18', source: 'cash', via: 'customer' });
  for (const k of Object.keys(st.prices || {})) if (/^da+l/.test(k)) delete st.prices[k];
}

for (const down of [false, true]) {
  test('19 Oct Krish Singh conversation, AI ' + (down ? 'down (rules)' : 'up (mock)') + ': true balance on the bill, "bs 40 rupaye" is a dispute for the owner, no menu', async () => {
    const ai = mockAi(down);
    const s = createServer({ env: { SHOP: 'gupta', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-d-')), AGENT37_LLM_PROXY_URL: 'https://router.test/v1' }, today: () => TODAY, fetch: ai });
    const base = await listen(s);
    try {
      setup(s.getState());
      const to = (id, from) => s.getState().messages.slice(from).filter((m) => m.from === 'agent' && m.to === id);
      await act(base, 'customer', { custId: 'C099', text: ORDER });
      const o = s.getState().orders.filter((x) => x.custId === 'C099').pop();
      assert.ok(o && o.status === 'ask', 'the order asks udhaar or cash');
      await act(base, 'orderAnswer', { custId: 'C099', orderId: o.id, udhaar: true });
      let from = s.getState().messages.length;
      await act(base, 'owner', { text: 'Daal 60' });
      const bill = to('C099', from).find((m) => m.kind === 'entry-check');
      assert.ok(bill, 'the item-wise bill goes out');
      assert.match(bill.text, /₹162 udhaar likha gaya/);
      assert.match(bill.text, /Kul baaki: ₹0 \(₹38 advance jama\)/, 'the true balance after the write, not a bare ₹0: ' + bill.text);
      assert.match(to('owner', from)[0].text, /Kul baaki: ₹0 \(₹38 advance jama\)/);
      assert.doesNotMatch(to('owner', from)[0].text, /₹-/);
      await act(base, 'customerCheck', { custId: 'C099', msgId: bill.id, ok: false });

      from = s.getState().messages.length;
      const calls = ai.prompts.length;
      await act(base, 'customer', { custId: 'C099', text: CLAIM });
      assert.equal(ai.prompts.length, calls + 1, 'the AI is asked');
      const p = ai.prompts[ai.prompts.length - 1].sys;
      assert.match(p, /Open dispute: .*₹162 udhaar \(19 Oct\)/, 'the open dispute is in the prompt');
      assert.match(p, /Recent conversation[\s\S]*Shop bot: .*₹162 udhaar \(19 Oct\) par aapka sawaal/, 'the last messages are in the prompt');
      assert.match(p, /Rs 200 paid in advance|Rs 38 paid in advance/);
      assert.match(p, /Last entries: .*₹162 udhaar/);
      const cust = to('C099', from), own = to('owner', from);
      assert.equal(cust.length, 1); assert.equal(own.length, 1);
      assert.doesNotMatch(cust[0].text, MENU, 'never the menu');
      assert.equal(cust[0].text, 'Aapki baat dukaan ko bhej di: aap ₹40 bol rahe hain, khate mein ₹0 (₹38 advance jama) hai. Dukaan check karke batayegi. 🙏');
      assert.match(own[0].text, /^⚠️ Krish Singh: "Mera udhar bs 40 rupaye hai" \(₹40 bol rahe hain; khata mein ₹0 \(₹38 advance jama\)\)\. ₹162 udhaar \(19 Oct\) wali entry par galat bola tha\./);
      if (!down) assert.match(own[0].text, /\(English: My udhaar is only 40 rupees\)/);
      const k = C.pendingClaims(s.getState()).filter((x) => x.custId === 'C099');
      assert.equal(k.length, 1, 'attached to the open dispute, not a second one');
      assert.equal(k[0].notes.length, 1); assert.equal(k[0].notes[0].amount, 40);

      // a relevant message with no action still reaches the owner (with its meaning), never a menu alone
      from = s.getState().messages.length;
      await act(base, 'customer', { custId: 'C099', text: 'saaman kab tak aayega bhaiya' });
      assert.doesNotMatch(to('C099', from)[0].text, MENU);
      assert.match(to('owner', from)[0].text, /Krish Singh: "saaman kab tak aayega bhaiya"/);
      // only what the AI marks irrelevant gets the menu
      if (!down) {
        from = s.getState().messages.length;
        await act(base, 'customer', { custId: 'C099', text: 'aur bhai kya haal' });
        assert.match(to('C099', from)[0].text, MENU);
        assert.equal(to('owner', from).length, 0);
      }
    } finally { s.close(); }
  });
}

test('a dispute with no open "galat" opens one for the evening ✅/❌; a correction is forwarded the same way', () => {
  const s = C.freshShop('gupta', TODAY);
  setup(s);
  C.runAction(s, 'owner', { text: 'krish singh ne 120 ka saman liya' });
  let r = C.runAction(s, 'customer', { custId: 'C099', text: 'maine itna nahi liya', intent: { intent: 'dispute', parser: 'llm', relevant: true, english: 'I did not take this much' } }).result;
  const k = C.pendingClaims(s).filter((x) => x.custId === 'C099');
  assert.equal(k.length, 1); assert.equal(k[0].type, 'check');
  assert.ok(r.some((m) => m.to === 'owner' && /Krish Singh: "maine itna nahi liya"/.test(m.text)));
  r = C.runAction(s, 'customer', { custId: 'C099', text: 'daal nahi chaaval tha', intent: { intent: 'correction', parser: 'llm', relevant: true } }).result;
  assert.ok(r.some((m) => m.to === 'owner' && /^✏️ Krish Singh: "daal nahi chaaval tha"/.test(m.text)));
  assert.ok(r.some((m) => m.to === 'C099' && /Aapki baat dukaan ko bhej di/.test(m.text)));
  assert.equal(C.pendingClaims(s).filter((x) => x.custId === 'C099')[0].notes.length, 2);
  assert.equal(C.balText(-38), '₹0 (₹38 advance jama)'); assert.equal(C.balText(162), '₹162');
});
