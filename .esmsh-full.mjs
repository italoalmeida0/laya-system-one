// The full path through esm.sh: import, load the wasm engine, fetch the model
// over HTTP, and answer. This is what a user actually does.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MIME = { '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json',
  '.wasm':'application/wasm', '.onnx':'application/octet-stream' };
// serve only the model + wasm (the code comes from esm.sh)
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto(base + 'tests/browser/page.html');

const result = await page.evaluate(async ({ base }) => {
  const out = { steps: [] };
  try {
    const { Laya } = await import('https://esm.sh/gh/italoalmeida0/laya-system-one@main/src/index.js');
    out.steps.push('imported');
    const laya = await Laya.load({
      backend: 'wasm',
      modelDir: base + 'models/',
      wasmBase: base + 'src/wasm-pkg/'
    });
    out.steps.push('loaded');
    const r = await laya.predict('We were billed twice and want a refund.', {
      department: { type: 'choice', instructions: 'Which department?',
        criteria: { billing: 'refunds', tech: 'bugs', sales: 'upgrades' } }
    });
    out.answer = r.answers.department.choice;
    out.conf = r.answers.department.confidence;
    await laya.close();
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}, { base });

console.log('RESULTADO:', JSON.stringify(result, null, 1));
if (logs.length) { console.log('LOGS:'); for (const l of logs.slice(0, 6)) console.log(' ', l); }
await browser.close();
srv.close();
process.exit(result.answer ? 0 : 1);
