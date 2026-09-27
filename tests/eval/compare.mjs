// Compare two models on the same dataset, through the same runtime.
//
// The dataset is the upstream project's evaluation fixture: 12 cases covering
// all three question types (choice, score, noul), each with the answer a human
// would give. Both models answer the identical prompts, so the only variable
// is the checkpoint.
//
//   node tests/eval/compare.mjs
//   node tests/eval/compare.mjs --laya <path> --julia <path>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const LAYA = val('laya', path.join(ROOT, 'models', 'model.onnx'));
const JULIA = val('julia', path.join(ROOT, 'julia-system-one', 'models', 'model.onnx'));

for (const [label, p] of [['laya', LAYA], ['julia', JULIA]]) {
  if (!fs.existsSync(p)) { console.error(`[eval] ${label} model not found: ${p}`); process.exit(1); }
}

const cases = fs.readFileSync(path.join(__dirname, 'fixture.jsonl'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => JSON.parse(l));

/** Run every case through one model, returning its answers. */
async function evaluate(modelPath, label) {
  const { Laya } = await import('../../src/agent.js');
  const prev = process.env.LAYA_MODEL_PATH;
  process.env.LAYA_MODEL_PATH = modelPath;
  let laya;
  try {
    laya = await Laya.load({ modelDir: path.dirname(modelPath), backend: 'native' });
    const out = [];
    for (const c of cases) {
      const res = await laya.predict(c.state, c.questions);
      out.push(res.answers);
    }
    return out;
  } finally {
    if (laya) await laya.close();
    if (prev === undefined) delete process.env.LAYA_MODEL_PATH;
    else process.env.LAYA_MODEL_PATH = prev;
  }
}

/** Is the model's answer the expected one, for its question type? */
function correct(type, answer, expected) {
  if (!answer) return false;
  if (type === 'choice') return answer.choice === expected;
  if (type === 'noul') return (answer.noul >= (answer.threshold ?? 0.5)) === expected;
  if (type === 'score') return Math.abs(answer.score - expected) <= 1;
  return false;
}

console.log(`[eval] ${cases.length} cases, native backend\n`);
const results = {};
for (const [label, modelPath] of [['laya', LAYA], ['julia', JULIA]]) {
  const t0 = Date.now();
  const answers = await evaluate(modelPath, label);
  const ms = Date.now() - t0;
  let pass = 0;
  const rows = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const [qid, qdef] = Object.entries(c.questions)[0];
    const a = answers[i][qid];
    const ok = correct(qdef.type, a, c.expected[qid]);
    if (ok) pass++;
    const got = qdef.type === 'choice' ? a?.choice
      : qdef.type === 'noul' ? (a?.noul >= (a?.threshold ?? 0.5))
      : a?.score;
    rows.push({ id: c.id, type: qdef.type, expected: c.expected[qid], got, ok });
  }
  results[label] = { pass, ms, rows };
  console.log(`[eval] ${label.padEnd(6)} ${pass}/${cases.length} correct in ${ms}ms`);
}

console.log('\n[eval] per case');
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const l = results.laya.rows[i];
  const j = results.julia.rows[i];
  const mark = (r) => (r.ok ? 'ok  ' : 'FAIL');
  console.log(`  ${mark(l)} ${mark(j)}  ${l.type.padEnd(6)} want ${String(l.expected).padEnd(8)} laya=${String(l.got).padEnd(8)} julia=${String(j.got).padEnd(8)} ${JSON.stringify(c.state.slice(0, 40))}`);
}

const l = results.laya, j = results.julia;
console.log(`\n[eval] laya  ${l.pass}/${cases.length}`);
console.log(`[eval] julia ${j.pass}/${cases.length}`);
console.log(`[eval] speed laya ${(l.ms / cases.length).toFixed(0)}ms/case, julia ${(j.ms / cases.length).toFixed(0)}ms/case`);
