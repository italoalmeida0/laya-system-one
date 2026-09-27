// The real question: does `import { Laya } from 'https://esm.sh/laya-system-one'`
// work in a browser? esm.sh does its own bundling and module rewriting, so a
// package that works when served from disk may still fail through the CDN.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on('requestfailed', r => logs.push(`[req failed] ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`));

// a real page on a real origin (about:blank has origin null and blocks modules)
await page.route('https://example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }));
await page.goto('https://example.test/');

const result = await page.evaluate(async () => {
  const out = { steps: [] };
  try {
    out.steps.push('importing from esm.sh');
    const mod = await import('https://esm.sh/laya-system-one@1.3.0');
    out.steps.push('imported: ' + Object.keys(mod).join(','));
    out.hasLaya = typeof mod.Laya === 'function';
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
});

console.log('RESULTADO:', JSON.stringify(result, null, 1));
console.log('\nLOGS:');
for (const l of logs.slice(0, 12)) console.log(' ', l);
await browser.close();
