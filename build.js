// Inlines core/agent-core.js into the web page. Outputs:
//   dist/udhaar-agent.html             page body (published as the hosted demo link)
//   dist/udhaar-agent-standalone.html  full HTML document (open in Chrome for live mic, or serve from any host)
//   index.html                         copy of the standalone page for GitHub Pages
const fs = require('fs');
const path = require('path');
const root = __dirname;
const core = fs.readFileSync(path.join(root, 'core/agent-core.js'), 'utf8');
const src = fs.readFileSync(path.join(root, 'web/index.src.html'), 'utf8');
const qr = fs.readFileSync(path.join(root, 'vendor/qrcode-generator.js'), 'utf8'); // MIT, Kazuhiko Arase
const page = src.replace('/*__CORE__*/', () => qr + '\n' + core);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/udhaar-agent.html'), page);
const standalone = '<!doctype html>\n<html lang="hi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>Udhaar Agent</title>\n</head>\n<body>\n' + page + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(root, 'dist/udhaar-agent-standalone.html'), standalone);
fs.writeFileSync(path.join(root, 'index.html'), standalone);
console.log('built dist/udhaar-agent.html, dist/udhaar-agent-standalone.html and index.html');
