#!/usr/bin/env node
// compare-all.js — full matrix: every bundled binary, same prompt, same box.
// Win bins run natively; linux bins via docker (ubuntu:24.04 / alpine:3.20);
// darwin-arm64 is skipped (no Mac hardware; Mach-O can't run here).
// Usage: node tools/compare-all.js [--trials N]
import { spawnSync, execSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const trials = parseInt((process.argv.find((a) => a.startsWith('--trials=')) || '').split('=')[1] || process.argv[process.argv.indexOf('--trials') + 1] || '3', 10) || 3;

const BODY = JSON.stringify({
  model: 'laya-multilingual',
  state: 'Hello, I was charged twice for my subscription and I want my money back. This is urgent, my invoice #8821.',
  questions: {
    department: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'Charges, refunds, invoices, payments', technical: 'Bugs, outages, errors', sales: 'Pricing plans, demos, quotes' } },
    refund: { type: 'noul', instructions: 'Is the customer asking for money back?' },
    urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['not urgent', 'normal', 'urgent'] },
  },
});
fs.writeFileSync(path.join(os.tmpdir(), 'laya-cmp-body.json'), BODY);

const CASES = [
  { name: 'win32-arm64 (native)', kind: 'native', bin: 'dist/bin/win32-arm64/laya-serve.exe' },
  { name: 'linux-x64 gnu (docker ubuntu:24.04)', kind: 'docker', img: 'ubuntu:24.04', app: 'dist/bin/linux-x64', cmd: '/app/laya-serve' },
  { name: 'linux-x64 musl bundle (docker alpine:3.20 puro)', kind: 'docker', img: 'alpine:3.20', app: 'dist/bin/linux-x64-musl', cmd: '/app/laya-serve.bundle', port: 8891 },
  { name: 'linux-arm64 gnu (docker ubuntu:24.04)', kind: 'docker', img: 'ubuntu:24.04', app: 'dist/bin/linux-arm64', cmd: '/app/laya-serve', arch: 'linux/arm64', port: 8892 },
  { name: 'linux-arm64 musl bundle (docker alpine:3.20 puro)', kind: 'docker', img: 'alpine:3.20', app: 'dist/bin/linux-arm64-musl', cmd: '/app/laya-serve.bundle', arch: 'linux/arm64', port: 8893 },
];

console.log('══════════════════════════════════════════════════════════════');
console.log('  LAYA full-matrix comparison (same box, same prompt, 3Q)');
console.log(`  trials=${trials}  (qemu x86 emulated where noted)`);
console.log('══════════════════════════════════════════════════════════════');

const results = [];
for (const c of CASES) {
  try {
    const r = c.kind === 'native' ? await runNative(c) : await runDocker(c);
    results.push({ name: c.name, ...r });
    console.log(`  ${c.name}: ${r.avg}ms avg [${r.runs.join(', ')}] choice=${r.choice} ${r.note || ''}`);
  } catch (e) {
    results.push({ name: c.name, error: String(e.message || e).slice(0, 120) });
    console.log(`  ${c.name}: FAILED — ${String(e.message || e).slice(0, 120)}`);
  }
}
console.log('──────────────────────────────────────────────────────────────');
console.log('  darwin-arm64: SKIPPED (no Mac hardware to execute Mach-O)');
console.log('══════════════════════════════════════════════════════════════');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runNative(c) {
  const { NativeServer } = await import('../../src/laya-native.js');
  const srv = new NativeServer({ modelDir: path.join(root, 'models'), port: 0 });
  // force binary
  process.env.LAYA_SERVE_BIN = path.join(root, c.bin);
  await srv.start();
  delete process.env.LAYA_SERVE_BIN;
  const out = await bench(srv.url);
  await srv.stop();
  return out;
}

async function bench(base) {
  const runs = [];
  let choice = '?';
  // warmup (compile caches, ORT arena)
  await post(base);
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now();
    const j = await post(base);
    runs.push(Math.round(performance.now() - t0));
    choice = j.answers.department.choice;
  }
  runs.sort((a, b) => a - b);
  return { runs, avg: Math.round(runs.reduce((a, b) => a + b, 0) / runs.length), choice };
}

async function post(base) {
  const r = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function runDocker(c) {
  const port = c.port || 8890;
  const appAbs = path.join(root, c.app).replace(/\\/g, '/');
  const modelsAbs = path.join(root, 'models').replace(/\\/g, '/');
  const arch = c.arch ? `--platform ${c.arch}` : '--platform linux/amd64';
  const cname = `laya-cmp-${port}`;
  exec(`docker rm -f ${cname}`);
  const isBundle = c.cmd.endsWith('.bundle');
  const runCmd = isBundle
    ? `cp /app/${path.basename(c.cmd)} /tmp/lb && chmod +x /tmp/lb && /tmp/lb --model-dir /models --host 0.0.0.0 --port 8899`
    : `${c.cmd} --model-dir /models --host 0.0.0.0 --port 8899`;
  exec(`docker run -d --name ${cname} ${arch} -v "${appAbs}:/app" -v "${modelsAbs}:/models:ro" -p ${port}:8899 ${c.img} sh -c "${runCmd}"`);
  // wait for health (max 120s)
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch { /* warming */ }
    if (Date.now() - t0 > 120000) throw new Error('server never became ready');
    await sleep(2000);
  }
  const out = await bench(`http://127.0.0.1:${port}`);
  out.note = c.arch ? '(qemu arm64)' : '(qemu x86)';
  exec(`docker rm -f ${cname}`);
  return out;
}

function exec(cmd) {
  try { return execSync(cmd, { stdio: 'pipe' }).toString(); } catch { return ''; }
}
