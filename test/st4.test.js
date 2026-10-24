// Regression tests for the Stress Test 4 findings (Jira epic KAN-94).
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const shop = () => C.freshShop('gupta', '2026-10-24');
function owner(s, text) {
  const m = s.messages.length, n = s.txns.length;
  C.runAction(s, 'owner', { text });
  return { txns: s.txns.slice(n), reply: s.messages.slice(m).filter((x) => x.to === 'owner').map((x) => x.text).join('\n') };
}

test('KAN-95: words that are Object.prototype keys never crash the parser', () => {
  const words = Object.getOwnPropertyNames(Object.prototype).concat(['__proto__', 'prototype']);
  const shapes = ['W ne 100 liya', 'W ji ne 100 liya', 'Pappu ne W 50 ka liya', 'W 2 kilo 50', 'W ka hisaab', 'Pappu ki list: W 20, cheeni 45', 'W ne 100 diye', 'W ko yaad dila do'];
  for (const w of words) for (const sh of shapes) {
    const text = sh.replace('W', w);
    assert.doesNotThrow(() => C.runAction(shop(), 'owner', { text }), text);
    assert.doesNotThrow(() => C.runAction(shop(), 'customer', { custId: 'C003', text }), 'customer: ' + text);
  }
  const r = owner(shop(), 'constructor ne 100 liya');
  assert.equal(r.txns.length, 0);
  assert.match(r.reply, /naya grahak/);
  const l = owner(shop(), 'Pappu ki list: constructor 20, cheeni 45');
  assert.equal(l.txns[0].amount, 65);
  assert.doesNotMatch(l.reply, /NaN/);
});

test('KAN-96: "kaat do" on a ₹0 khata says so; a number inside an entry is always answered', () => {
  const s = shop();
  const k = owner(s, 'Sharma ji ka 300 kaat do');
  assert.equal(k.txns.length, 0);
  assert.equal(s.pending, null);
  assert.match(k.reply, /kuch baaki nahi hai/);
  assert.doesNotMatch(k.reply, /₹0 → ₹0/);
  const same = owner(s, 'Sharma ji 9876500001 500 udhaar');
  assert.equal(same.txns[0].amount, 500);
  assert.match(same.reply, /yahi number \(9876500001\) pehle se save hai/);
  const fresh = owner(s, 'Sharma ji 9822011111 50 udhaar');
  assert.equal(fresh.txns[0].amount, 50);
  assert.match(fresh.reply, /9822011111 save kar liya \(pehle xxxxxx0001 tha\)/);
  assert.equal(C.getCust(s, fresh.txns[0].custId).phone, '9822011111');
});
