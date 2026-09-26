#!/usr/bin/env node
/**
 * publish-all.js — publish every @sys-one package, locally, in the right order.
 *
 * Publication happens on YOUR machine (you can `npm login` without dealing
 * with long-lived tokens in CI). The heavy lifting - building the binaries
 * for all platforms and cutting the model into chunks - is done by GitHub
 * Actions, which uploads the finished packages as artifacts. This script:
 *
 *   1. downloads those artifacts into dist/release/   (gh CLI)
 *   2. re-checks every package (name, version, os/cpu, binary present)
 *   3. publishes the leaf packages first (binaries + model chunks), then the
 *      main entry package `laya-system-one`, because npm needs the
 *      optionalDependencies to exist before the package that points at them
 *      can be installed by anyone.
 *
 *   node tools/publish-all.js download --run <run-id>   # fetch artifacts
 *   node tools/publish-all.js publish  --tag alpha      # npm publish
 *   node tools/publish-all.js publish  --tag latest --dry-run
 *
 * `--tag alpha` publishes under the `alpha` dist-tag, so
 * `npm i laya-system-one@alpha` gets it while `@latest` stays untouched.
 * `--tag latest` is the real release: never run it before the alpha is
 * verified (see .github/workflows/verify-published.yml).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'dist', 'release');
const BIN_DIR = path.join(RELEASE_DIR, 'binaries');
const CHUNK_DIR = path.join(RELEASE_DIR, 'model-chunks');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
    } else args._.push(a);
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  return r.status ?? 1;
}

function runCapture(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

function readMain() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/** Every directory under dir that has a package.json (i.e. a package). */
function packageDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'package.json')))
    .map((e) => path.join(root, e.name));
}

/* ------------------------------ commands ------------------------------ */

function cmdDownload(args) {
  const runId = args.run;
  if (!runId) {
    console.error('usage: publish-all.js download --run <github-actions-run-id>');
    console.error('       (find it with: gh run list --workflow=release-packages.yml)');
    process.exit(1);
  }
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  console.log(`[publish] downloading artifacts of run ${runId} into dist/release/ ...`);
  const status = run('gh', ['run', 'download', String(runId), '--dir', RELEASE_DIR]);
  if (status !== 0) {
    console.error('[publish] gh run download failed. Is the gh CLI logged in (gh auth status)?');
    process.exit(1);
  }
  console.log('[publish] done. Inspecting what arrived:');
  cmdInspect();
}

function cmdInspect() {
  const groups = { binaries: packageDirs(BIN_DIR), chunks: packageDirs(CHUNK_DIR) };
  let bad = 0;
  for (const [kind, dirs] of Object.entries(groups)) {
    console.log(`\n[inspect] ${kind}: ${dirs.length} package(s)`);
    for (const dir of dirs) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const problems = [];
      if (!pkg.name?.startsWith('@sys-one/')) problems.push('not in the @sys-one scope');
      if (!pkg.version) problems.push('no version');
      const binDir = path.join(dir, 'bin');
      if (kind === 'binaries' && (!fs.existsSync(binDir) || fs.readdirSync(binDir).length === 0)) {
        problems.push('no binary payload');
      }
      if (kind === 'chunks' && !fs.existsSync(path.join(dir, 'chunk.bin'))) {
        problems.push('no chunk.bin');
      }
      const flag = problems.length ? `FAIL (${problems.join('; ')})` : 'ok';
      if (problems.length) bad++;
      console.log(`  ${flag.padEnd(6)} ${pkg.name}@${pkg.version}`);
    }
  }
  if (bad) {
    console.error(`\n[inspect] ${bad} package(s) are not publishable`);
    process.exit(1);
  }
  console.log('\n[inspect] all packages look publishable ✔');
}

async function cmdPublish(args) {
  const tag = args.tag || 'alpha';
  const dryRun = args['dry-run'] === true;
  if (!['alpha', 'beta', 'latest', 'next'].includes(tag)) {
    console.error(`[publish] refusing unknown tag '${tag}' (use alpha|beta|next|latest)`);
    process.exit(1);
  }
  if (tag === 'latest' && !args['i-understand-latest']) {
    console.error(
      '[publish] `--tag latest` is the real release. Verify the alpha first:\n'
      + '  npm i laya-system-one@alpha  (on each platform)\n'
      + 'then re-run with --i-understand-latest.'
    );
    process.exit(1);
  }

  const who = runCapture('npm', ['whoami']);
  if (who.status !== 0) {
    console.error('[publish] not logged in to npm. Run: npm login');
    process.exit(1);
  }
  console.log(`[publish] logged in as ${who.stdout.trim()}, tag=${tag}${dryRun ? ' (dry run)' : ''}\n`);

  // leaf packages first: the model chunks and the platform binaries must
  // exist before the main package that depends on them.
  const order = [
    ...packageDirs(CHUNK_DIR),
    ...packageDirs(BIN_DIR),
    ROOT // the entry package last
  ];

  const results = [];
  for (const dir of order) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.private) { results.push([pkg.name, 'skipped (private)']); continue; }

    const npmArgs = ['publish', '--tag', tag, '--access', 'public'];
    if (dryRun) npmArgs.push('--dry-run');
    const r = runCapture('npm', npmArgs, { cwd: dir });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) {
      // republishing the same version is the most common failure: reporting
      // it clearly beats a wall of npm output.
      if (/cannot publish over|EPUBLISHCONFLICT|previously published/i.test(out)) {
        results.push([pkg.name, 'already published (skipped)']);
        continue;
      }
      console.error(`\n[publish] FAILED ${pkg.name}@${pkg.version}:\n${out}`);
      console.error('[publish] stopping so you can fix it before the rest go out.');
      process.exit(1);
    }
    results.push([pkg.name, dryRun ? 'dry-run ok' : 'published']);
    console.log(`  ✓ ${pkg.name}@${pkg.version}`);
  }

  console.log('\n[publish] summary:');
  for (const [name, status] of results) console.log(`  ${status.padEnd(24)} ${name}`);
  if (!dryRun) {
    console.log(`\n[publish] done. Try it:\n  npm i laya-system-one@${tag}\n`);
    console.log('[publish] next: let the verify workflow install and run it on every platform:');
    console.log('  gh workflow run verify-published.yml -f version=<version> -f tag=' + tag);
  }
}

function cmdListLocal() {
  const dirs = [...packageDirs(CHUNK_DIR), ...packageDirs(BIN_DIR)];
  console.log(`[publish] ${dirs.length} leaf package(s) staged in dist/release/`);
  for (const d of dirs) {
    const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
    console.log(`  ${p.name}@${p.version}`);
  }
  const main = readMain();
  console.log(`  ${main.name}@${main.version}  (entry package)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'download') cmdDownload(args);
  else if (cmd === 'inspect') cmdInspect();
  else if (cmd === 'publish') cmdPublish(args);
  else if (cmd === 'list') cmdListLocal();
  else {
    console.log(`publish-all.js — publish the @sys-one packages from your machine

  download --run <id>              fetch the packages built by GitHub Actions
  inspect                          check every staged package is publishable
  list                             show the staged leaf packages
  publish --tag alpha              publish (safe: alpha dist-tag)
  publish --tag latest --i-understand-latest
                                   the real release (verify the alpha first)
  publish --tag alpha --dry-run    show what would be published
`);
  }
}

main();
