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

/** The platform packages the entry package must depend on. */
export const REQUIRED_SERVE_PKGS = [
  '@sys-one/laya-serve-darwin-arm64',
  '@sys-one/laya-serve-darwin-x64',
  '@sys-one/laya-serve-win32-x64',
  '@sys-one/laya-serve-win32-arm64',
  '@sys-one/laya-serve-linux-x64',
  '@sys-one/laya-serve-linux-arm64',
  '@sys-one/laya-serve-universal'
];

/**
 * Check that the entry package depends on exactly the right things, each at
 * the right version. Pure, so it can be tested directly.
 *
 * Two different rules, because the two kinds of package depend on different
 * things: binaries are compiled from this commit and follow the package
 * version, while the model chunks are cut from the checkpoint and follow the
 * MODEL version. Pinning the chunks to the package version would republish
 * 235 MB of identical data on every code-only release.
 */
export function checkPackageVersions(pkg, root) {
  const problems = [];
  const opt = pkg.optionalDependencies || {};

  for (const name of REQUIRED_SERVE_PKGS) {
    if (!opt[name]) {
      problems.push(`optionalDependencies must list ${name} (the native binary ships as a package)`);
    } else if (opt[name] !== pkg.version) {
      problems.push(`${name} is pinned to ${opt[name]} but the package version is ${pkg.version}`);
    }
  }

  const manifestPath = path.join(root, 'models', 'model.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    problems.push('models/model.manifest.json is missing (needed to know the model version)');
    return problems;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const modelVersion = manifest.modelVersion || manifest.version || '1.0.0';

  for (let i = 0; i < Number(manifest.chunkCount || 0); i++) {
    const name = `@sys-one/laya-model-chunk-${String(i).padStart(2, '0')}`;
    if (!opt[name]) {
      problems.push(`optionalDependencies must list ${name} (the model ships as chunk packages)`);
    } else if (opt[name] !== modelVersion) {
      problems.push(`${name} is pinned to ${opt[name]}, expected the model version ${modelVersion}`);
    }
  }

  return problems;
}

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

for (const problem of checkPackageVersions(pkg, ROOT)) problems.push(problem);

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
