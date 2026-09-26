#!/usr/bin/env node
/**
 * laya compare — terminal benchmark: Laya local (ONNX) vs Jev cloud (OpenRouter).
 *
 * Usage:
 *   node tools/compare.js [--trials 5] [--mode tetris|support|both] [--local-url http://127.0.0.1:8080]
 *   npm run compare -- --trials 5 --mode both
 *
 * Reads OPENROUTER_TEST_KEY from .env (project root) or env var.
 * - Local runs in-process (no HTTP overhead) AND optionally via HTTP server.
 * - Jev runs via https://openrouter.ai/api/v1/systemone (model typesafe/jev-1.13).
 * Reports: mean/p50/p95 latency, choice, confidence, agreement, cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const out = {};
  for (const p of [path.join(ROOT, '.env'), path.join(process.cwd(), '.env')]) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* no .env */ }
  }
  return out;
}

const dotenv = loadDotEnv();
const OPENROUTER_KEY = process.env.OPENROUTER_TEST_KEY || dotenv.OPENROUTER_TEST_KEY || '';
const JEV_URL = 'https://openrouter.ai/api/v1/systemone';
const JEV_MODEL = 'typesafe/jev-1.13';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.findIndex(a => a === name || a.startsWith(name + '='));
  if (i === -1) return def;
  const a = args[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return args[i + 1] ?? def;
}
const TRIALS = Math.max(1, parseInt(arg('--trials', '5'), 10) || 5);
const MODE = (arg('--mode', 'both') || 'both').toLowerCase();
const LOCAL_URL = arg('--local-url', null);

const SCENARIOS = {
  tetris: {
    label: 'TETRIS (game move — out-of-domain for local model)',
    model: 'laya-multilingual',
    state: 'Tetris piece T, height 5/20',
    questions: {
      move: {
        type: 'choice',
        instructions: 'Select the best Tetris placement to clear lines and keep the board flat.',
        criteria: { a: 'rot0 col0 score 12', b: 'rot1 col3 score 15', c: 'rot0 col5 score 9' }
      }
    }
  },
  support: {
    label: 'SUPPORT TRIAGE (in-domain — local model fine-tuned for this)',
    model: 'laya-multilingual',
    state: 'Hello, I was charged twice for my subscription and I want my money back. This is urgent, my invoice #8821.',
    questions: {
      department: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'Charges, refunds, invoices, payments', technical: 'Bugs, outages, errors', sales: 'Pricing plans, demos, quotes' } },
      refund: { type: 'noul', instructions: 'Is the customer asking for money back?' },
      urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['not urgent', 'normal', 'urgent'] }
    }
  }
};

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const p50 = s[Math.floor(0.5 * (s.length - 1))];
  const p95 = s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))];
  return { mean, p50, p95, min: s[0], max: s[s.length - 1] };
};
const fmt = (n) => n.toFixed(0) + 'ms';

async function runLocalInProcess(scn, trials) {
  const { Laya } = await import('../../src/agent.js');
  const t0 = performance.now();
  const laya = await Laya.load({ device: 'auto' });
  const loadMs = performance.now() - t0;
  // Drop the first inference: it still pays per-shape kernel tuning even
  // after engine warmup (different seqLen/markers than the warmup probe).
  await laya.predict(scn.state, scn.questions, scn.model);
  const lat = [], outs = [];
  for (let i = 0; i < trials; i++) {
    const a = performance.now();
    const out = await laya.predict(scn.state, scn.questions, scn.model);
    lat.push(performance.now() - a);
    outs.push(out);
  }
  return { loadMs, lat, last: outs[outs.length - 1] };
}

async function runLocalHttp(url, scn, trials) {
  const ep = url.endsWith('/v1/systemone') ? url : url.replace(/\/+$/, '') + '/v1/systemone';
  const body = JSON.stringify({ model: scn.model, state: scn.state, questions: scn.questions });
  const lat = []; let last = null;
  for (let i = 0; i < trials; i++) {
    const a = performance.now();
    const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    last = await r.json();
    lat.push(performance.now() - a);
    if (!r.ok) throw new Error('local HTTP ' + r.status + ' ' + JSON.stringify(last).slice(0, 200));
  }
  return { lat, last };
}

async function runJev(scn, trials) {
  if (!OPENROUTER_KEY) throw new Error('missing key: set OPENROUTER_TEST_KEY in .env or env');
  const H = { 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/laya-system-one', 'X-Title': 'laya-compare' };
  const body = JSON.stringify({ model: JEV_MODEL, state: scn.state, questions: scn.questions });
  const lat = []; let last = null; let cost = 0;
  for (let i = 0; i < trials; i++) {
    const a = performance.now();
    const r = await fetch(JEV_URL, { method: 'POST', headers: H, body });
    const j = await r.json();
    lat.push(performance.now() - a);
    if (!r.ok) throw new Error('jev HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    last = j;
    cost += j?.usage?.cost ?? 0;
  }
  return { lat, last, cost };
}

function summarizeAnswers(answers) {
  const out = {};
  for (const [k, a] of Object.entries(answers || {})) {
    if (a.type === 'choice') out[k] = `${a.choice} (conf ${(a.confidence ?? 0).toFixed(2)})`;
    else if (a.type === 'noul') out[k] = `${a.decision ? 'YES' : 'NO'} (p=${(a.noul ?? 0).toFixed(2)})`;
    else if (a.type === 'score') out[k] = `${(a.score ?? 0).toFixed(2)} (conf ${(a.confidence ?? 0).toFixed(2)})`;
    else out[k] = JSON.stringify(a).slice(0, 80);
  }
  return out;
}

function agreement(a, b) {
  const keys = Object.keys(a || {});
  if (!keys.length) return 'n/a';
  let same = 0;
  for (const k of keys) {
    const x = a[k], y = (b || {})[k];
    if (!x || !y || x.type !== y.type) continue;
    if (x.type === 'choice' && x.choice === y.choice) same++;
    else if (x.type === 'noul' && !!x.decision === !!y.decision) same++;
    else if (x.type === 'score' && Math.abs((x.score ?? 0) - (y.score ?? 0)) < 0.5) same++;
  }
  return `${same}/${keys.length}`;
}

console.log('═'.repeat(70));
console.log('  LAYA local vs JEV cloud — terminal comparison');
console.log('═'.repeat(70));
console.log(`  trials=${TRIALS}  mode=${MODE}` + (LOCAL_URL ? `  local-url=${LOCAL_URL}` : '  local=in-process'));
console.log(`  jev: ${JEV_MODEL} via OpenRouter ${OPENROUTER_KEY ? '(key ok, ' + OPENROUTER_KEY.length + ' chars)' : '(NO KEY!)'}`);
console.log('');

const modes = MODE === 'both' ? ['tetris', 'support'] : [MODE];
if (!modes.every(m => SCENARIOS[m])) { console.error('bad --mode, use tetris|support|both'); process.exit(1); }

// Load ONCE and reuse across scenarios: a second InferenceSession in the
// same process doubles RAM (~600MB+) and thread contention, skewing results.
const { Laya } = await import('../../src/agent.js');
const __t0 = performance.now();
const __laya = await Laya.load({ device: 'auto' });
const __loadMs = performance.now() - __t0;
console.log(`  local model loaded once in ${fmt(__loadMs)} (reused for all scenarios)`);
console.log('');

async function runLocalReuse(scn, trials) {
  await __laya.predict(scn.state, scn.questions, scn.model); // discard first (per-shape tuning)
  const lat = [], outs = [];
  for (let i = 0; i < trials; i++) {
    const a = performance.now();
    const out = await __laya.predict(scn.state, scn.questions, scn.model);
    lat.push(performance.now() - a);
    outs.push(out);
  }
  return { loadMs: __loadMs, lat, last: outs[outs.length - 1] };
}

const __results = {};
for (const m of modes) {
  const scn = SCENARIOS[m];
  console.log('─'.repeat(70));
  console.log('  SCENARIO: ' + scn.label);
  console.log('─'.repeat(70));

  process.stdout.write('  local (laya ONNX, CPU) … ');
  const local = await runLocalReuse(scn, TRIALS);
  __results[m] = { local };
  const ls = stats(local.lat);
  console.log(`load ${fmt(local.loadMs)} | ${local.lat.map(fmt).join(' ')}`);
  console.log(`    → mean ${fmt(ls.mean)}  p50 ${fmt(ls.p50)}  p95 ${fmt(ls.p95)}  (min ${fmt(ls.min)})`);

  let httpStats = null;
  if (LOCAL_URL) {
    try {
      const h = await runLocalHttp(LOCAL_URL, scn, TRIALS);
      httpStats = stats(h.lat);
      console.log(`  local via HTTP … mean ${fmt(httpStats.mean)}  p50 ${fmt(httpStats.p50)}`);
    } catch (e) { console.log('  local via HTTP … FAILED: ' + e.message); }
  }


  console.log('');
}

// Jev AFTER all local runs: OpenRouter calls take ~300-700ms each, and any
// idle gap lets the OS throttle the CPU (Snapdragon X). Running Jev last
// keeps local numbers clean and comparable.
if (OPENROUTER_KEY) {
  for (const m of modes) {
    const scn = SCENARIOS[m];
    const local = __results[m].local;
    const ls = stats(local.lat);
    console.log('─'.repeat(70));
    console.log('  JEV CLOUD: ' + scn.label);
    console.log('─'.repeat(70));
    process.stdout.write('  jev cloud (OpenRouter) … ');
    try {
      const jev = await runJev(scn, TRIALS);
      const js = stats(jev.lat);
      console.log(`${jev.lat.map(fmt).join(' ')}`);
      console.log(`    → mean ${fmt(js.mean)}  p50 ${fmt(js.p50)}  p95 ${fmt(js.p95)}  cost $${jev.cost.toFixed(6)}`);
      console.log('  answers:');
      console.log('    local:', JSON.stringify(summarizeAnswers(local.last.answers)));
      console.log('    jev  :', JSON.stringify(summarizeAnswers(jev.last.answers)));
      console.log(`  agreement: ${agreement(local.last.answers, jev.last.answers)}  |  speedup local-vs-jev: ${(js.mean / Math.max(1, ls.mean)).toFixed(1)}x`);
    } catch (e) { console.log('FAILED: ' + e.message); }
    console.log('');
  }
} else {
  console.log('  jev … SKIPPED (no OPENROUTER_TEST_KEY)');
}
console.log('═'.repeat(70));
console.log('  NOTE: tetris is out-of-domain for the local 309MB support-tuned');
console.log('  checkpoint → expect Jev to choose better; local wins on latency.');
console.log('  support triage is in-domain → expect agreement + local faster.');
console.log('═'.repeat(70));
