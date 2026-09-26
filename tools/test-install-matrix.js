#!/usr/bin/env node
/**
 * test-install-matrix.js — prove the os/cpu package selection actually works.
 *
 * Optional dependencies are only useful if npm really installs the matching
 * package for a platform and skips the rest. That is the whole premise of
 * splitting the binaries out, so it gets tested for real: for every
 * platform we ship we create a throwaway project whose package.json pins
 * one platform via npm's `--os`/`--cpu` override (npm 10+), installs the
 * packed tarballs, and checks that
 *   (a) exactly the expected package(s) landed, and
 *   (b) the JS loader resolves a binary out of node_modules.
 *
 *   node tools/test-install-matrix.js                 # all targets
 *   node tools/test-install-matrix.js --only linux-x64
 *
 * Tarballs must exist first:
 *   node tools/build-platform-packages.js build && \
 *   node tools/build-platform-packages.js pack
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARBALLS = path.join(ROOT, 'dist', 'pkgs', 'tarballs');

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** platform -> the packages npm is expected to keep for it */
const TARGETS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', keep: ['laya-serve-darwin-arm64'], slot: 'darwin-arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', keep: ['laya-serve-darwin-x64'], slot: 'darwin-x64' },
  'win32-x64': { os: 'win32', cpu: 'x64', keep: ['laya-serve-win32-x64'], slot: 'win32-x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', keep: ['laya-serve-win32-arm64'], slot: 'win32-arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64', keep: ['laya-serve-linux-x64'], slot: 'linux-x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', keep: ['laya-serve-linux-arm64'], slot: 'linux-arm64' }
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

function tarballFor(bareName) {
  // npm pack names a scoped package's tarball <scope>-<name>-<version>.tgz,
  // i.e. @sys-one/laya-serve-linux-x64 -> laya-laya-serve-linux-x64-1.1.0.tgz
  return path.join(TARBALLS, `sys-one-${bareName}-${VERSION}.tgz`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

async function main() {
  const only = arg('only', null);
  if (!fs.existsSync(TARBALLS)) {
    console.error('[matrix] no tarballs; run:\n  node tools/build-platform-packages.js build\n  node tools/build-platform-packages.js pack');
    process.exit(1);
  }
  const available = fs.readdirSync(TARBALLS).filter((f) => f.endsWith('.tgz'));
  if (available.length === 0) {
    console.error('[matrix] dist/pkgs/tarballs is empty');
    process.exit(1);
  }

  const npmMajor = Number(run('npm', ['--version']).stdout.trim().split('.')[0]);
  if (npmMajor < 10) {
    console.error(`[matrix] npm ${npmMajor} does not support --os/--cpu overrides; need npm >= 10`);
  }

  let failures = 0;
  for (const [label, t] of Object.entries(TARGETS)) {
    if (only && only !== label) continue;

    // skip targets whose tarball was not built in this checkout
    const needed = t.keep.map((k) => tarballFor(k));
    const present = needed.filter((p) => fs.existsSync(p));
    if (present.length === 0) {
      console.log(`[matrix] SKIP ${label.padEnd(14)} (no tarball built)`);
      continue;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `laya-matrix-${label}-`));
    try {
      const wants = needed.filter((p) => fs.existsSync(p)).map((p) => path.relative(dir, p));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: `install-test-${label}`,
        version: '0.0.0',
        private: true,
        optionalDependencies: Object.fromEntries(
          t.keep.map((k, i) => [`@sys-one/${k}`, `file:${wants[i]}`])
        )
      }, null, 2));

      const inst = run('npm', [
        'install', '--no-audit', '--no-fund', '--ignore-scripts',
        `--os=${t.os}`, `--cpu=${t.cpu}`
      ], { cwd: dir });
      if (inst.status !== 0) {
        console.log(`[matrix] FAIL ${label.padEnd(14)} npm install errored\n${inst.stderr}`);
        failures++;
        continue;
      }

      const installed = t.keep.filter((k) => fs.existsSync(path.join(dir, 'node_modules', ...`@sys-one/${k}`.split('/'))));
      const binaryRel = path.join('node_modules', '@sys-one', t.keep[0], 'bin', t.slot,
        t.os === 'win32' ? 'laya-serve.exe' : 'laya-serve');
      const binaryThere = fs.existsSync(path.join(dir, binaryRel));

      const ok = installed.length === 1 && binaryThere;
      console.log(`[matrix] ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(14)} installed=[${installed.join(',') || '-'}] binary=${binaryThere ? 'yes' : 'NO'}`);
      if (!ok) failures++;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n[matrix] ${failures === 0 ? 'all targets selected correctly ✔' : `${failures} target(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
