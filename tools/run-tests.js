#!/usr/bin/env node
/**
 * run-tests.js — cross-platform / cross-version test runner.
 *
 * Why not `node --test "tests/unit/*.test.js"` in package.json:
 *   - the quotes stop `sh` from expanding the glob, so Node receives a
 *     literal `*.test.js` string;
 *   - Node only started expanding globs for `--test` in v21, so on Node
 *     18/20 the run dies with "Could not find ... *.test.js";
 *   - Windows `cmd` never expands globs at all.
 *
 * This runner resolves the file list itself and hands explicit paths to
 * `node --test`, which works the same everywhere.
 *
 *   node tools/run-tests.js tests/unit [tests/e2e ...] [-- <extra node args>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const nodeArgs = [];
const targets = [];

let inNodeArgs = false;
for (const a of argv) {
  if (a === '--') { inNodeArgs = true; continue; }
  if (inNodeArgs) nodeArgs.push(a);
  else targets.push(a);
}

function collect(p, out) {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(abs).sort()) {
      const child = path.join(abs, entry);
      if (fs.statSync(child).isDirectory()) collect(child, out);
      else if (/\.(test\.(js|mjs|cjs))$/.test(entry)) out.push(child);
    }
  } else {
    out.push(abs);
  }
}

const files = [];
for (const t of targets) collect(t, files);

if (!files.length) {
  console.error(`[run-tests] no test files found for: ${targets.join(', ') || '(nothing)'}`);
  process.exit(1);
}

console.log(`[run-tests] ${files.length} file(s):`);
for (const f of files) console.log(`[run-tests]   ${path.relative(ROOT, f)}`);

const res = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], {
  stdio: 'inherit',
  cwd: ROOT
});
process.exit(res.status ?? 1);
