// Test the GitHub route: esm.sh serves the repo at the pushed commit, so this
// validates the fix without publishing anything.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message.slice(0, 200)}`));
page.on('requestfailed', r => logs.push(`[req failed] ${r.url().slice(0, 100)} :: ${r.failure()?.errorText}`));

await page.route('https://example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }));
await page.goto('https://example.test/');

const result = await page.evaluate(async () => {
  const out = { steps: [] };
  try {
    out.steps.push('importing');
    const mod = await import('https://esm.sh/gh/italoalmeida0/laya-system-one@main/src/index.js');
    out.steps.push('imported ok');
    out.exports = Object.keys(mod);
    out.hasLaya = typeof mod.Laya === 'function';
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
});

console.log('RESULTADO:', JSON.stringify(result, null, 1));
if (logs.length) { console.log('\nLOGS:'); for (const l of logs.slice(0, 8)) console.log(' ', l); }
await browser.close();
process.exit(result.hasLaya ? 0 : 1);
