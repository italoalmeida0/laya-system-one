#!/usr/bin/env node
/**
 * preflight-publish.js — refuse to publish an incomplete package.
 *
 * `npm publish` silently SKIPS `files` entries that do not exist, so a
 * missing native binary produces a "successful" but broken release. This
 * check makes that impossible.
 *
 *   node tools/preflight-publish.js [--allow-missing-dist]
 *
 * --allow-missing-dist  tolerate absent dist/ build outputs (dev checkouts
 *                       that have not built the native binaries).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowMissingDist = process.argv.includes('--allow-missing-dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];

/* ------------------- 1. every files entry must exist ---------------- */

for (const entry of pkg.files || []) {
  const target = path.join(ROOT, entry);
  const isDir = entry.endsWith('/');

  if (isDir) {
    if (!fs.existsSync(target) || fs.readdirSync(target).length === 0) {
      const msg = `files entry is empty or missing: ${entry}`;
      if (entry.startsWith('dist/') && allowMissingDist) console.log(`[preflight] WARN: ${msg}`);
      else problems.push(msg);
    }
    continue;
  }

  if (!fs.existsSync(target)) {
    const msg = `files entry does not exist: ${entry}`;
    if (entry.startsWith('dist/') && allowMissingDist) console.log(`[preflight] WARN: ${msg}`);
    else problems.push(msg);
  }
}

/* ---------------- 2. the packed tarball must be complete ------------ */

let packed = [];
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_fund: 'false' }
  });
  const [meta] = JSON.parse(out.slice(out.indexOf('[')));
  packed = meta.files.map((f) => f.path);

  console.log(`[preflight] tarball      : ${meta.filename}`);
  console.log(`[preflight] files        : ${meta.entryCount}`);
  console.log(`[preflight] package size : ${(meta.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[preflight] unpacked     : ${(meta.unpackedSize / 1024 / 1024).toFixed(1)} MB`);

  const LIMIT = 200 * 1024 * 1024;
  if (meta.size >= LIMIT) {
    problems.push(`tarball is ${(meta.size / 1024 / 1024).toFixed(1)} MB — npm rejects payloads near/over 200 MB (HTTP 413)`);
  }
} catch (err) {
  problems.push(`npm pack --dry-run failed: ${err.message}`);
}

/* ------------------ 3. platform binaries must ship ------------------ */

const REQUIRED_BINARIES = [
  'dist/bin/win32-x64/laya-serve.exe',
  'dist/bin/win32-arm64/laya-serve.exe',
  'dist/bin/linux-x64/laya-serve',
  'dist/bin/linux-arm64/laya-serve',
  'dist/bin/darwin-arm64/laya-serve',
  'dist/bin/darwin-x64/laya-serve',
  'dist/bin/linux-x64-musl/laya-serve.bundle',
  'dist/bin/linux-arm64-musl/laya-serve.bundle'
];

for (const bin of REQUIRED_BINARIES) {
  const inTarball = packed.includes(bin);
  const onDisk = fs.existsSync(path.join(ROOT, bin));
  if (!inTarball) {
    const msg = `native binary missing from the tarball: ${bin}`;
    if (allowMissingDist && !onDisk) console.log(`[preflight] WARN: ${msg}`);
    else problems.push(msg);
  }
}

/* ---------------------- 4. core files must ship --------------------- */

for (const must of ['src/index.js', 'src/model-resolver.js', 'bin/cli.js', 'models/model.manifest.json', 'README.md', 'LICENSE']) {
  if (!packed.includes(must)) problems.push(`required file missing from the tarball: ${must}`);
}

for (const name of packed) {
  if (name.startsWith('tests/') || name.startsWith('tools/') || name.endsWith('.onnx') || name.includes('.env')) {
    problems.push(`file must not be published: ${name}`);
  }
}

/* ------------------------------ report ------------------------------ */

if (problems.length) {
  for (const p of problems) console.error(`[preflight] FAIL: ${p}`);
  console.error(`\n[preflight] ${problems.length} problem(s) — refusing to publish`);
  process.exit(1);
}
console.log('[preflight] package is complete ✔');
