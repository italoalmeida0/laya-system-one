#!/usr/bin/env node
/**
 * bench.js - latency benchmark for the inference backends.
 *
 * Measures what a user actually feels:
 *   init_ms   time to load the model and be ready
 *   cold_ms   the very first question (includes warmup/specialization)
 *   warm_*    the following N questions (default 10): avg / p50 / p95 / min / max
 *   qps       sustained throughput from the warm average
 *
 *   node tools/bench.js                        # native backend
 *   node tools/bench.js --backend wasm         # the fallback path
 *   node tools/bench.js --questions 10 --json bench.json
 *
 * The native binary is the primary path; the wasm numbers are only here to
 * quantify what the safety net costs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const backend = arg('--backend', process.env.LAYA_BACKEND || 'native');
const N = parseInt(arg('--questions', '10'), 10);
const jsonOut = arg('--json', null);

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: { billing: 'refunds and invoices', tech: 'bugs and crashes', sales: 'upgrades and contracts' }
  },
  severity: {
    type: 'score',
    instructions: 'Urgency level?',
    criteria: ['low', 'medium', 'high']
  },
  churn: { type: 'noul', instructions: 'Is the user at churn risk?', threshold: 0.5 },
  refund: { type: 'noul', instructions: 'Is a refund explicitly requested?', threshold: 0.5 }
};

const PROMPTS = [
  'We were billed twice on the March invoice and want a refund.',
  'The app crashes with a segfault when I open the settings page.',
  'Fui cobrado em duplicidade na minha fatura e quero reembolso.',
  'Me cobraron dos veces en mi factura y quiero un reembolso.',
  'Can I upgrade my plan to the enterprise tier next month?',
  'Your service has been down for six hours and nobody answers.',
  'I love the product, but the invoice address needs updating.',
  'この請求書の金額が間違っていると思います。',
  'Need help resetting my password, the email never arrives.',
  'The refund was promised last week but has not arrived yet.',
  'Do you support SSO with SAML for our organization?',
  'My subscription renewed although I cancelled it in January.'
];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    avg_ms: +avg.toFixed(1),
    p50_ms: +pct(s, 50).toFixed(1),
    p95_ms: +pct(s, 95).toFixed(1),
    min_ms: +s[0].toFixed(1),
    max_ms: +s[s.length - 1].toFixed(1),
    qps: +(1000 / avg).toFixed(2)
  };
};

const { Laya } = await import('../src/agent.js');

console.log(`\n=== laya-system-one bench ===`);
console.log(`platform : ${os.platform()}-${os.arch()} (${process.platform === 'linux' ? 'linux' : ''}${os.type()})`);
console.log(`runtime  : ${typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version}`);
console.log(`backend  : ${backend}`);
console.log(`questions: ${N}\n`);

const t0 = performance.now();
const laya = await Laya.load({ modelDir: path.join(ROOT, 'models'), backend, wasmWorkers: 1 });
const init_ms = +(performance.now() - t0).toFixed(1);
console.log(`init     : ${init_ms} ms`);

// cold question (first inference: warmup, graph specialization, ...)
const t1 = performance.now();
await laya.predict(PROMPTS[0], QUESTIONS);
const cold_ms = +(performance.now() - t1).toFixed(1);
console.log(`cold     : ${cold_ms} ms  (first question)`);

// warm questions
const times = [];
for (let i = 0; i < N; i++) {
  const prompt = PROMPTS[i % PROMPTS.length];
  const s = performance.now();
  await laya.predict(prompt, QUESTIONS);
  times.push(performance.now() - s);
}
const warm = stats(times);
console.log(`warm     : avg ${warm.avg_ms} ms | p50 ${warm.p50_ms} | p95 ${warm.p95_ms} | min ${warm.min_ms} | max ${warm.max_ms} | ${warm.qps} q/s`);

// single-question latency (one question per call, no batch)
const single = [];
for (let i = 0; i < N; i++) {
  const s = performance.now();
  await laya.predict(PROMPTS[i % PROMPTS.length], { q: { type: 'noul', instructions: 'urgent?', threshold: 0.5 } });
  single.push(performance.now() - s);
}
const one = stats(single);
console.log(`1 q/call : avg ${one.avg_ms} ms | p50 ${one.p50_ms} | p95 ${one.p95_ms} | ${one.qps} q/s`);

await laya.close();

const result = {
  platform: `${os.platform()}-${os.arch()}`,
  os_type: os.type(),
  runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`,
  backend,
  questions_per_call: 4,
  init_ms,
  cold_ms,
  warm_4q: warm,
  warm_1q: one,
  measured_at: new Date().toISOString()
};

if (jsonOut) {
  fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(result, null, 2) + '\n');
  console.log(`\n[json] -> ${jsonOut}`);
}
console.log('');
process.exit(0);
