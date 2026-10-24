// Inlines the compiled core (dist-server/core/agent-core.js, from core/agent-core.ts; run tsc first) into the web page. Outputs:
//   dist/udhaar-agent.html             page body (published as the hosted demo link)
//   dist/udhaar-agent-standalone.html  full HTML document (open in Chrome for live mic, or serve from any host)
//   index.html                         copy of the standalone page for GitHub Pages
const fs = require('fs');
const path = require('path');
const root = __dirname;
// The compiled core is a CommonJS module (module.exports = UdhaarCore); in the page it runs inside a small wrapper
// that gives it a module object and publishes the result as window.UdhaarCore, as the old UMD header did.
const compiled = fs.readFileSync(path.join(root, 'dist-server/core/agent-core.js'), 'utf8');
const core = '(function () {\nvar module = { exports: {} }, exports = module.exports;\n' + compiled + '\nself.UdhaarCore = module.exports;\n})();';
const src = fs.readFileSync(path.join(root, 'web/index.src.html'), 'utf8');
const qr = fs.readFileSync(path.join(root, 'vendor/qrcode-generator.js'), 'utf8'); // MIT, Kazuhiko Arase
const page = src.replace('/*__CORE__*/', () => qr + '\n' + core);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/udhaar-agent.html'), page);
const standalone = '<!doctype html>\n<html lang="hi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>Udhaar Agent</title>\n</head>\n<body>\n' + page + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(root, 'dist/udhaar-agent-standalone.html'), standalone);
fs.writeFileSync(path.join(root, 'index.html'), standalone);
// the live test-run page: same core, plus the hand-written cases and the runner (test/live/); the commit is shown on the page
let build = 'local build';
try { build = require('child_process').execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || build; } catch (e) {}
const live = ['test/live/cases.js', 'test/live/runner.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const testRun = fs.readFileSync(path.join(root, 'web/test-run.src.html'), 'utf8').split('/*__BUILD__*/').join(build).replace('/*__CORE__*/', () => (core + '\n' + live).replace(/<\/script/gi, '<\\/script')); // a case types "<script>…</script>"; keep it inside the inline script
fs.writeFileSync(path.join(root, 'dist/test-run.html'), testRun);
fs.writeFileSync(path.join(root, 'test-run.html'), testRun);
console.log('built dist/udhaar-agent.html, dist/udhaar-agent-standalone.html, index.html and test-run.html');
