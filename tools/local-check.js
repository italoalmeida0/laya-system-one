#!/usr/bin/env node
/**
 * local-check.js — the full pre-publish gate, run on your machine.
 *
 * Nothing here belongs in CI: linting, the whole test suite and a complete
 * install rehearsal are developer concerns, and running them on every push
 * costs minutes and money to answer a question you can answer locally in one
 * command. The point is to make "should I publish?" a question this script
 * answers, before anything reaches the registry.
 *
 * What it does, in order, and stops at the first failure:
 *
 *   lint            syntax + packaging metadata + doc claims
 *   unit            the fast offline suite
 *   packaging       what `npm pack` actually ships
 *   integration     real model, real binary (exactly 10 questions)
 *   e2e             the HTTP/CLI protocol
 *   packages        build the @sys-one platform packages
 *   install-rehearsal
 *                   spin up a LOCAL npm registry (fake, no network), install
 *                   laya-system-one together with the packages it would get
 *                   from the real registry, then load and use it. This is the
 *                   closest thing to "what a user will experience" that can
 *                   run before publishing.
 *
 *   node tools/local-check.js                 # everything
 *   node tools/local-check.js --quick         # lint + unit + packaging + rehearsal
 *   node tools/local-check.js --only=e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const QUICK = has('--quick');

/** step id -> { label, cmd, env, needsModel } */
const STEPS = {
  lint: { label: 'lint (syntax + packaging + docs)', run: () => npm(['run', 'lint']) },
  unit: { label: 'unit tests', run: () => npm(['run', 'test:unit']) },
  packaging: { label: 'packaging (what npm pack ships)', run: () => npm(['run', 'test:packaging']) },
  integration: {
    label: 'integration (real binary, 10 questions)',
    run: () => npm(['run', 'test:integration']),
    needsModel: true
  },
  e2e: { label: 'e2e (HTTP + CLI protocol)', run: () => npm(['run', 'test:e2e']) },
  packages: {
    label: 'build @sys-one platform packages',
    run: () => {
      npm(['run', 'pkgs:build']);
      return npm(['run', 'pkgs:pack']);
    }
  },
  'install-rehearsal': {
    label: 'install rehearsal (local registry, no network)',
    run: () => npm(['run', 'test:rehearsal'])
  }
};

const ORDER = QUICK
  ? ['lint', 'unit', 'packaging', 'packages', 'install-rehearsal']
  : ['lint', 'unit', 'packaging', 'integration', 'e2e', 'packages', 'install-rehearsal'];
const selected = only ? [only] : ORDER;

function npm(npmArgs, extraEnv = {}) {
  execFileSync('npm', npmArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv }
  });
}

function banner(text) {
  const line = '─'.repeat(Math.min(text.length + 4, 76));
  console.log(`\n${line}\n  ${text}\n${line}`);
}

function main() {
  const started = Date.now();
  const hasModel = fs.existsSync(path.join(ROOT, 'models', 'model.onnx'));
  console.log(`[local-check] ${QUICK ? 'quick' : 'full'} run on ${process.platform}-${process.arch}`);
  if (!hasModel) {
    console.log('[local-check] models/model.onnx is absent: steps that need it will be skipped.');
    console.log('              (run `npm run model:acquire` to fetch it)');
  }

  const results = [];
  for (const id of selected) {
    const step = STEPS[id];
    if (!step) {
      console.error(`[local-check] unknown step '${id}' (known: ${Object.keys(STEPS).join(', ')})`);
      process.exit(1);
    }
    if (step.needsModel && !hasModel) {
      console.log(`\n[local-check] SKIP ${step.label} (no model)`);
      results.push([id, 'skipped']);
      continue;
    }
    banner(step.label);
    try {
      step.run();
      results.push([id, 'ok']);
    } catch {
      results.push([id, 'FAILED']);
      break; // stop at the first failure: fixing one thing at a time
    }
  }

  banner('summary');
  for (const [id, status] of results) {
    console.log(`  ${status.padEnd(8)} ${STEPS[id].label}`);
  }
  const failed = results.some(([, s]) => s === 'FAILED');
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (failed) {
    console.log(`\n[local-check] FAILED after ${mins} min — do NOT publish.`);
    process.exit(1);
  }
  console.log(`\n[local-check] everything passed in ${mins} min.`);
  console.log('[local-check] publish with:  node tools/publish-all.js download --run <id>');
  console.log('                            node tools/publish-all.js publish --tag alpha');
  process.exit(0);
}

main();
