#!/usr/bin/env node
/**
 * model-diff.js — compare two models on the same prompts, through the real
 * engine.
 *
 * When the upstream checkpoint is re-exported (a longer context, a retrained
 * head, a new quantization), the question that matters is not "is the file
 * valid" but "does it still answer the same, and where does it differ". This
 * runs both files through the same code path the package uses and reports it.
 *
 *   node tools/model-diff.js --model models/model.onnx --against /tmp/new.onnx
 *   node tools/model-diff.js --model /tmp/new.onnx          # vs the shipped one
 *   node tools/model-diff.js --model /tmp/new.onnx --json   # machine-readable
 *
 * Exit code is 0 when the two agree on every decisive prompt, 1 otherwise, so
 * it can gate a model update.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (flag) => args.includes(flag);

const candidate = val('model', null);
if (!candidate) {
  console.error('usage: model-diff.js --model <new.onnx> [--against <old.onnx>] [--json]');
  process.exit(1);
}
const baseline = val('against', path.join(ROOT, 'models', 'model.onnx'));

for (const [label, p] of [['candidate', candidate], ['baseline', baseline]]) {
  if (!fs.existsSync(p)) {
    console.error(`[diff] ${label} not found: ${p}`);
    process.exit(1);
  }
}

/** Prompts with the answer the shipped model is known to give. */
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
  ['We would like to purchase more seats for our account.', 'sales'],
  ['The refund was promised last week but has not arrived yet.', 'billing'],
  ['Do you support SSO with SAML for our organization?', 'sales'],
  ['Need help resetting my password, the email never arrives.', 'tech'],
  ['I love the product, but the invoice address needs updating.', 'billing'],
  ['Can I upgrade my plan to the enterprise tier next month?', 'sales']
];

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: { billing: 'refunds and invoices', tech: 'bugs and crashes', sales: 'upgrades and contracts' }
  }
};

/**
 * Load a model file and answer every prompt, returning the probabilities.
 * The file is handed over through LAYA_MODEL_PATH: the native server resolves
 * the model itself, and that variable is the documented way to point it at a
 * specific file. `modelDir` alone would pick up whatever model.onnx is there.
 */
async function evaluate(modelPath) {
  const { Laya } = await import('../src/agent.js');
  const prev = process.env.LAYA_MODEL_PATH;
  process.env.LAYA_MODEL_PATH = modelPath;
  let laya;
  try {
    laya = await Laya.load({ modelDir: path.dirname(modelPath), backend: 'native' });
    const out = [];
    for (const [prompt] of CASES) {
      const res = await laya.predict(prompt, QUESTIONS);
      const a = res.answers.department;
      out.push({ choice: a.choice, probabilities: a.probabilities, confidence: a.confidence });
    }
    return out;
  } finally {
    if (laya) await laya.close();
    if (prev === undefined) delete process.env.LAYA_MODEL_PATH;
    else process.env.LAYA_MODEL_PATH = prev;
  }
}

const t0 = Date.now();
console.log(`[diff] baseline : ${baseline}`);
console.log(`[diff] candidate: ${candidate}\n`);

const base = await evaluate(baseline);
const cand = await evaluate(candidate);

let sameLabel = 0;
let maxDrift = 0;
const rows = [];

for (let i = 0; i < CASES.length; i++) {
  const [prompt, expected] = CASES[i];
  const b = base[i];
  const c = cand[i];
  const agree = b.choice === c.choice;
  if (agree) sameLabel++;

  // largest per-label probability movement, which is what "drift" means here
  let drift = 0;
  for (const label of Object.keys(b.probabilities || {})) {
    const d = Math.abs((b.probabilities[label] ?? 0) - (c.probabilities[label] ?? 0));
    if (d > drift) drift = d;
  }
  if (drift > maxDrift) maxDrift = drift;

  rows.push({
    prompt,
    expected,
    baseline: b.choice,
    candidate: c.choice,
    agree,
    drift: Number(drift.toFixed(4)),
    confidence: Number((c.confidence ?? 0).toFixed(4))
  });
}

if (has('--json')) {
  console.log(JSON.stringify({ baseline, candidate, rows, sameLabel, maxDrift }, null, 2));
} else {
  for (const r of rows) {
    const mark = r.agree ? 'ok  ' : 'DIFF';
    console.log(`[diff] ${mark} ${String(r.baseline).padEnd(8)} -> ${String(r.candidate).padEnd(8)} drift ${String(r.drift).padEnd(6)} ${JSON.stringify(r.prompt.slice(0, 46))}`);
  }
  console.log(`\n[diff] same label: ${sameLabel}/${CASES.length} | max probability drift: ${maxDrift.toFixed(4)}`);
  console.log(`[diff] took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// A model update is allowed to move probabilities slightly (a different
// quantization does), but a changed label on a decisive prompt is a regression
// worth looking at before shipping.
if (sameLabel < CASES.length) {
  console.error(`\n[diff] ${CASES.length - sameLabel} prompt(s) changed answer - review before shipping`);
  process.exit(1);
}
console.log('\n[diff] the candidate answers every prompt the same way ✔');
process.exit(0);
