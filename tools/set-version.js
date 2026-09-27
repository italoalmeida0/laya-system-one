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
 * Three versions, because three things change independently:
 *   - the package version      (this package's own code)
 *   - `binaryVersion`          (the Rust binary; only changes when native/ does)
 *   - the model version        (the checkpoint; only changes when the model does)
 *
 * A code-only release therefore republishes just the entry package: the
 * binaries and the 235 MB of model chunks keep the versions already on the
 * registry and the publish step skips them.
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

/** The checkpoint's version, from the manifest; independent of the package. */
function readModelVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'model.manifest.json'), 'utf8'));
    return manifest.modelVersion || manifest.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
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
//
// The two kinds are pinned differently: binaries are compiled from this
// commit and follow the package version, while the model chunks follow the
// checkpoint's version (they are not rebuilt when only the code changes).
edit('package.json', (j) => {
  const prev = j.version;
  j.version = version;
  const modelVersion = readModelVersion();
  const binaryVersion = j.binaryVersion || version;
  for (const name of Object.keys(j.optionalDependencies || {})) {
    if (!name.startsWith('@sys-one/')) continue;
    if (name.includes('model-chunk')) j.optionalDependencies[name] = modelVersion;
    else j.optionalDependencies[name] = binaryVersion;
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

// models/model.manifest.json is deliberately NOT touched: the chunk packages
// are versioned by the model, not by the package. Rewriting them here would
// republish 235 MB of identical data on every release and force every user to
// re-download it. Bump the model version explicitly with
// `node tools/model-chunks.js build --model-version <n>` when the checkpoint
// itself changes.

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
