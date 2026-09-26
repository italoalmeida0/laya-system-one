#!/usr/bin/env node
/**
 * lint.js — dependency-free repo hygiene gate.
 *
 * Kept deliberately simple and deterministic (no external linter to install):
 *   1. syntax-check every .js file with `node --check`
 *   2. package.json sanity (semver, bin, files, engines)
 *   3. documentation consistency — README must not repeat claims that were
 *      already proven false (the old README said the 324 MB model was
 *      "embedded directly within the package" and advertised WebGPU as an
 *      accelerator; neither is true).
 *
 * Exit code 0 = clean, 1 = problems found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tmp', '.cache']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ------------------------- 1. syntax check -------------------------- */

const jsFiles = walk(ROOT).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`syntax error in ${path.relative(ROOT, file)}: ${String(err.stderr || err.message).slice(0, 300)}`);
  }
}
console.log(`[lint] syntax-checked ${jsFiles.length} file(s)`);

/* ------------------------ 2. package.json --------------------------- */

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (!/^\d+\.\d+\.\d+/.test(pkg.version || '')) problems.push('package.json: version must be semver');
if (pkg.type !== 'module') problems.push('package.json: type must be "module"');
if (!pkg.main) problems.push('package.json: main is required');
if (!pkg.bin?.['laya-system-one']) problems.push('package.json: bin["laya-system-one"] is required');
if (!pkg.license) problems.push('package.json: license is required');
if (!pkg.files?.length) problems.push('package.json: files whitelist is required');
if (!pkg.engines?.node) warnings.push('package.json: consider declaring engines.node');

if (pkg.files) {
  for (const entry of pkg.files) {
    const p = path.join(ROOT, entry);
    const isDir = entry.endsWith('/');
    if (!fs.existsSync(p) && !isDir) {
      // entries like "dist/bin/win32-x64/" are build outputs (gitignored)
      if (!entry.startsWith('dist/')) problems.push(`package.json: files entry does not exist: ${entry}`);
    }
  }
  const joined = pkg.files.join('\n');
  if (/^tests/m.test(joined)) problems.push('package.json: tests must not be published');
  if (/^tools/m.test(joined)) problems.push('package.json: tools must not be published');
  if (!/model\.manifest\.json/.test(joined)) problems.push('package.json: models/model.manifest.json must ship (checksums)');
}

const mainEntry = path.join(ROOT, pkg.main || 'src/index.js');
if (!fs.existsSync(mainEntry)) problems.push(`package.json: main entry not found: ${pkg.main}`);
for (const bin of Object.values(pkg.bin || {})) {
  const p = path.join(ROOT, bin);
  if (!fs.existsSync(p)) problems.push(`package.json: bin entry not found: ${bin}`);
  else {
    const head = fs.readFileSync(p, 'utf8').slice(0, 40);
    if (!head.startsWith('#!')) problems.push(`bin/${path.basename(bin)}: missing shebang`);
  }
}

/* --------------------- 3. documentation honesty --------------------- */

const README = path.join(ROOT, 'README.md');
if (fs.existsSync(README)) {
  const text = fs.readFileSync(README, 'utf8').toLowerCase();

  // claims that were already shipped once and turned out to be wrong
  const banned = [
    ['is embedded directly within the package', 'the model is NOT embedded — it is acquired at runtime'],
    ['zero external network requests at runtime', 'the model is fetched on first use'],
    ['webgpu and wasm simd acceleration', 'WebGPU is not an accelerator here (ORT node EP is slower than native CPU)'],
    ['sub-20ms latency', 'unverified latency claim']
  ];
  for (const [phrase, why] of banned) {
    if (text.includes(phrase)) problems.push(`README.md: stale claim "${phrase}" — ${why}`);
  }

  const required = [
    ['npm install', 'README must show how to install'],
    ['/v1/systemone', 'README must document the wire endpoint'],
    ['model', 'README must explain model acquisition'],
    ['not used server-side', 'README must state the honest position on WebGPU']
  ];
  for (const [needle, why] of required) {
    if (!text.includes(needle)) problems.push(`README.md: missing "${needle}" — ${why}`);
  }
} else {
  problems.push('README.md missing');
}

if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) problems.push('LICENSE missing');
if (!fs.existsSync(path.join(ROOT, 'CHANGELOG.md'))) warnings.push('CHANGELOG.md missing');

/* ------------------------------ report ------------------------------ */

for (const w of warnings) console.log(`[lint] WARN: ${w}`);
if (problems.length) {
  for (const p of problems) console.log(`[lint] FAIL: ${p}`);
  console.log(`\n[lint] ${problems.length} problem(s) found`);
  process.exit(1);
}
console.log('[lint] clean ✔');
