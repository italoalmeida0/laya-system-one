#!/usr/bin/env node
/**
 * set-version.js — set the package version everywhere it is recorded.
 *
 * The build workflow needs to produce packages for a specific version, chosen
 * when the build is started:
 *
 *   gh workflow run build-packages.yml -f version=1.1.0-alpha.0
 *
 * rather than whatever package.json happened to say when the commit was
 * pushed. Getting this wrong is expensive: npm skips an optionalDependency
 * that does not exist silently, so an entry package pointing at a version
 * nobody published installs cleanly and then finds no binary at runtime.
 *
 * Updates package.json, its version inside package-lock.json, and the version
 * recorded for each chunk in models/model.manifest.json, so every artifact of
 * the build agrees.
 *
 *   node tools/set-version.js 1.1.0-alpha.0
 *   node tools/set-version.js --check 1.1.0-alpha.0   # verify, change nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const version = args.find((a) => !a.startsWith('--'));

if (!version) {
  console.error('usage: set-version.js [--check] <version>');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`set-version: "${version}" is not a valid semver version`);
  process.exit(1);
}

const touched = [];
const mismatches = [];

/** Set version fields, reporting instead of writing when --check. */
function edit(file, mutate) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return;
  const before = fs.readFileSync(abs, 'utf8');
  const json = JSON.parse(before);
  const found = mutate(json);
  const after = JSON.stringify(json, null, 2) + '\n';
  if (found !== undefined && found !== version) mismatches.push(`${file}: ${found}`);

  if (checkOnly || before === after) return;
  fs.writeFileSync(abs, after);
  touched.push(file);
}

// package.json: the version the published entry package will carry, and the
// @sys-one packages it depends on - npm skips a missing optionalDependency
// silently, so a stale pin here ships an install that finds no binary.
edit('package.json', (j) => {
  const prev = j.version;
  j.version = version;
  for (const name of Object.keys(j.optionalDependencies || {})) {
    if (name.startsWith('@sys-one/')) j.optionalDependencies[name] = version;
  }
  return prev;
});

// package-lock.json: both root-level fields npm compares
edit('package-lock.json', (j) => {
  const prev = j.version;
  j.version = version;
  if (j.packages && j.packages['']) j.packages[''].version = version;
  return prev;
});

// models/model.manifest.json: each chunk carries the version it was cut for,
// and the chunk packages must be publishable under the same number
edit('models/model.manifest.json', (j) => {
  const prev = (j.chunks || [])[0]?.version;
  for (const chunk of j.chunks || []) chunk.version = version;
  return prev;
});

if (checkOnly) {
  if (mismatches.length) {
    console.error(`[set-version] these files are NOT at ${version}:`);
    for (const m of mismatches) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log(`[set-version] every file is already at ${version} ✔`);
  process.exit(0);
}

console.log(`[set-version] version set to ${version}`);
for (const f of touched) console.log(`  updated ${f}`);
if (touched.length === 0) console.log('  (already up to date)');
