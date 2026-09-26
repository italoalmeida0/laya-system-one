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

/* ------------- 3. the platform packages must be declared ------------ */

const REQUIRED_SERVE_PKGS = [
  '@sys-one/laya-serve-darwin-arm64',
  '@sys-one/laya-serve-darwin-x64',
  '@sys-one/laya-serve-win32-x64',
  '@sys-one/laya-serve-win32-arm64',
  '@sys-one/laya-serve-linux-x64',
  '@sys-one/laya-serve-linux-arm64',
  '@sys-one/laya-serve-universal'
];

const opt = pkg.optionalDependencies || {};
for (const name of REQUIRED_SERVE_PKGS) {
  if (!opt[name]) {
    problems.push(`optionalDependencies must list ${name} (the native binary ships as a package)`);
  } else if (opt[name] !== pkg.version) {
    problems.push(`${name} is pinned to ${opt[name]} but the package version is ${pkg.version}`);
  }
}

const chunkCount = Number(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'model.manifest.json'), 'utf8')).chunkCount || 0
);
for (let i = 0; i < chunkCount; i++) {
  const name = `@sys-one/laya-model-chunk-${String(i).padStart(2, '0')}`;
  if (!opt[name]) problems.push(`optionalDependencies must list ${name} (the model ships as chunk packages)`);
  else if (opt[name] !== pkg.version) problems.push(`${name} is pinned to ${opt[name]}, expected ${pkg.version}`);
}

// A built release must also have the packaged binaries on disk, so that
// `publish-all.js` has something to upload. Dev checkouts tolerate absence.
const binPkgRoot = path.join(ROOT, 'dist', 'release', 'binaries');
const builtPkgs = fs.existsSync(binPkgRoot)
  ? fs.readdirSync(binPkgRoot).filter((d) => fs.existsSync(path.join(binPkgRoot, d, 'package.json')))
  : [];
if (builtPkgs.length === 0) {
  const msg = 'no platform packages built in dist/release/binaries (run tools/build-platform-packages.js build)';
  if (allowMissingDist) console.log(`[preflight] WARN: ${msg}`);
  else problems.push(msg);
}

/* ---------------------- 4. core files must ship --------------------- */

for (const must of ['src/index.js', 'src/model-resolver.js', 'src/laya-native.js', 'src/bpe-tokenizer.js', 'bin/cli.js', 'bin/postinstall.js', 'models/model.manifest.json', 'README.md', 'LICENSE']) {
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
