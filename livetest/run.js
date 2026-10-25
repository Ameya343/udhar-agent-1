// The live test run from the command line (the page web/test-run.src.html runs the same cases in the browser).
// npm run build first. Run: node livetest/run.js [--fails] [--json out.json]
const path = require('path');
const C = require(path.join(__dirname, '..', 'dist-server', 'core', 'agent-core.js'));
const { TODAY, CAT, cases } = require('./cases.js');
const { runCase } = require('./runner.js');
const t0 = Date.now();
const results = cases.map((k) => runCase(C, k, TODAY));
const by = {};
for (const r of results) { const b = by[r.cat] = by[r.cat] || { run: 0, pass: 0 }; b.run++; if (r.pass) b.pass++; }
const pass = results.filter((r) => r.pass).length;
console.log('UdhaarAgent live test run: ' + pass + '/' + results.length + ' passed in ' + (Date.now() - t0) + ' ms (rules parser, no AI model, throwaway demo shop)');
for (const k in by) console.log('  ' + (CAT[k].label + '                              ').slice(0, 30) + by[k].pass + '/' + by[k].run);
if (process.argv.includes('--fails')) for (const r of results.filter((x) => !x.pass)) console.log('\n#' + r.id + ' [' + r.cat + '] ' + r.input + '\n  expected: ' + r.expected + '\n  actual:   ' + r.actual + '\n  why:      ' + r.why.join(', ') + '\n  reply:    ' + r.reply);
const j = process.argv.indexOf('--json');
if (j > 0) require('fs').writeFileSync(process.argv[j + 1], JSON.stringify({ pass, total: results.length, by, results }, null, 1));
