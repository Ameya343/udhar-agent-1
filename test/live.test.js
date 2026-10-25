// The live test-run page (/test-run): the hand-written cases load, run on a throwaway shop and never crash the core.
// Pass/fail of single cases is not asserted here: failing cases are open bugs, shown on the page and logged in Jira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../dist-server/core/agent-core.js');
const { TODAY, CAT, cases } = require('../livetest/cases.js');
const { runCase } = require('../livetest/runner.js');

test('500+ cases in named groups, each step with an expectation', () => {
  assert.ok(cases.length >= 500, cases.length + ' cases');
  for (const k of cases) { assert.ok(CAT[k.cat], 'group ' + k.cat); for (const s of k.steps) assert.ok(s.expect && Object.keys(s.expect).length, '#' + k.id); }
});

test('every case runs without crashing the core', () => {
  const crashed = cases.map((k) => runCase(C, k, TODAY)).filter((r) => r.why.some((w) => /^crashed/.test(w)));
  assert.deepStrictEqual(crashed.map((r) => '#' + r.id + ' ' + r.input), []);
});

test('the page is built with the core and the cases, and the inline script is not cut by "</script>" in a case', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'test-run.html'), 'utf8');
  assert.equal(html.split('</script>').length - 1, 2, 'only the two real script ends');
  const body = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
  assert.match(body, /root\.UdhaarCases = make/); assert.match(body, /root\.UdhaarRunner = make/); assert.match(body, /freshShop/);
});

test('the shop dashboard does not link to the test run: it is a separate page with its own link', () => {
  for (const f of ['index.html', 'dist/udhaar-agent.html', 'dist/udhaar-agent-standalone.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(html, /href="\/?test-run/, f);
  }
});
