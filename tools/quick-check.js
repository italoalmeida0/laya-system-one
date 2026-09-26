#!/usr/bin/env node
/**
 * quick-check.js — "did it build, and does it answer?" in one command.
 *
 * This is the check CI runs on each platform right after building the binary.
 * It is deliberately small: 10 questions through the model that was just
 * built, asserting the answers are the right ones. Compile failures and a
 * binary that starts but cannot infer are the two things worth catching
 * immediately; everything deeper is checked locally (tools/local-check.js)
 * or against the published package (verify-published.yml).
 *
 *   node tools/quick-check.js                       # this checkout's binary
 *   node tools/quick-check.js --binary dist/bin/linux-x64/laya-serve
 *   node tools/quick-check.js --model models/model.onnx
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const explicitBinary = val('binary', null);
if (explicitBinary) {
  process.env.LAYA_SERVE_BIN = path.resolve(ROOT, explicitBinary);
}

const modelPath = val('model', null);
if (modelPath && !process.env.LAYA_MODEL_PATH) {
  process.env.LAYA_MODEL_PATH = path.resolve(ROOT, modelPath);
}

/** The 10 questions, each with the answer that must come back. */
const CASES = [
  ['We were billed twice on the March invoice and want a refund.', 'billing'],
  ['The application crashes with a segfault when I open the settings page.', 'tech'],
  ['Fui cobrado em duplicidade na minha fatura e quero reembolso.', 'billing'],
  ['Me cobraron dos veces en mi factura y quiero un reembolso.', 'billing'],
  ['Your service has been down for six hours and nobody answers.', 'tech'],
  ['The app freezes and throws an exception on startup.', 'tech'],
  ['I was charged the wrong amount on my last invoice.', 'billing'],
  ['Quero fazer upgrade do meu plano para o empresarial.', 'sales'],
  ['Can you send me a quote for the business tier?', 'sales'],
  ['We would like to purchase more seats for our account.', 'sales']
];

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: { billing: 'refunds and invoices', tech: 'bugs and crashes', sales: 'upgrades and contracts' }
  }
};

const { Laya } = await import('../src/agent.js');

console.log(`[quick] platform: ${process.platform}-${process.arch}`);
if (explicitBinary) console.log(`[quick] binary  : ${process.env.LAYA_SERVE_BIN}`);

const t0 = Date.now();
const laya = await Laya.load({ modelDir: path.join(ROOT, 'models'), backend: 'native' });
console.log(`[quick] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let pass = 0;
const failures = [];
const t1 = Date.now();
for (const [prompt, expected] of CASES) {
  let got;
  try {
    const out = await laya.predict(prompt, QUESTIONS);
    got = out.answers.department.choice;
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  const ok = got === expected;
  if (ok) pass++;
  else failures.push({ prompt, expected, got });
  console.log(`[quick] ${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(16)} ${JSON.stringify(prompt.slice(0, 52))}`);
}
const ms = Date.now() - t1;

await laya.close();

console.log(`\n[quick] ${pass}/${CASES.length} correct in ${(ms / 1000).toFixed(1)}s (${(ms / CASES.length).toFixed(0)}ms each)`);
if (failures.length) {
  console.log('[quick] mismatches:');
  for (const f of failures) console.log(`  expected ${f.expected}, got ${f.got} -> ${f.prompt}`);
}
// One or two near-ties flipping between backends is tolerated (INT8 numerics
// differ per platform); a broken build is nowhere near 8/10.
const threshold = 8;
if (pass < threshold) {
  console.error(`[quick] FAILED: only ${pass}/${CASES.length} correct (need ${threshold})`);
  process.exit(1);
}
console.log('[quick] the binary builds and answers ✔');
process.exit(0);
