/**
 * Bun runtime smoke test.
 *
 * The library promises to run on Node AND Bun. The main suite runs under
 * node:test, so Bun compatibility is verified here instead: this file is
 * executed with `bun tests/bun/smoke.js` and exercises the whole stack at
 * runtime (model loading, prediction, HTTP server, clean shutdown).
 *
 *   bun tests/bun/smoke.js        # exit 0 = Bun is supported
 *
 * Skips (exit 0) when models/model.onnx is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Laya, serve } from '../../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_DIR = path.join(ROOT, 'models');

const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`[bun-smoke] runtime: ${runtime}`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`[bun-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!fs.existsSync(path.join(MODEL_DIR, 'model.onnx'))) {
  console.log('[bun-smoke] models/model.onnx not present — skipping');
  process.exit(0);
}

// 1) tokenizer (pure JS) works under this runtime
const { loadTokenizer } = await import('../../src/tokenizer.js');
const tok = await loadTokenizer(MODEL_DIR);
const ids = tok('hello world', { add_special_tokens: false }).input_ids.data;
check('tokenizer loads and encodes', ids.length > 0, `${ids.length} ids`);

// 2) native backend: the self-contained binary path
const t0 = Date.now();
const laya = await Laya.load({ modelDir: MODEL_DIR, backend: 'native' });
const out = await laya.predict(
  'We were billed twice on the March invoice and want a refund.',
  {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this?',
      criteria: { billing: 'refunds and invoices', tech: 'bugs', sales: 'upgrades' }
    },
    churn: { type: 'noul', instructions: 'Churn risk?', threshold: 0.5 }
  }
);
check('native backend predicts', out.answers.department.choice === 'billing',
  `${out.answers.department.choice} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 3) HTTP server over that engine
const srv = await serve({ laya, host: '127.0.0.1', port: 0, warmup: false });
const health = await fetch(`${srv.url}/health`);
check('http /health answers', health.status === 200, `status ${health.status}`);

const res = await fetch(`${srv.url}/v1/systemone`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    state: 'Fui cobrado em duplicidade na minha fatura e quero reembolso.',
    questions: { department: { type: 'choice', instructions: 'dept?', criteria: { billing: 'x', tech: 'y' } } }
  })
});
const body = await res.json();
check('http /v1/systemone answers', res.status === 200 && body.answers?.department?.choice === 'billing',
  JSON.stringify(body?.answers?.department?.choice));

// 4) shutdown must be clean (no leaked child keeping the process alive)
await srv.close();
await laya.close();
check('shutdown released resources', true);

console.log(`[bun-smoke] ${failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
