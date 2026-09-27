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
import { spawn, spawnSync } from 'node:child_process';

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

/**
 * Run a command with a real terminal attached.
 *
 * `npm publish` decides how to authenticate by looking at whether its output
 * is a terminal. With a piped stdout it cannot open the browser flow, so it
 * falls back to asking for a one-time password and fails with EOTP when none
 * is supplied. Inheriting all three streams gives npm the TTY it needs, so it
 * prints the login URL and waits for the browser, exactly like `npm login`.
 *
 * The trade-off is that the output cannot be captured for error matching, so
 * failures are judged by the exit code and "already published" is checked
 * beforehand with `npm view`.
 */
function runInteractive(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...opts
    });
    child.on('error', () => resolve({ code: 1 }));
    child.on('close', (code) => resolve({ code }));
  });
}

/** True when name@version already exists on the registry. */
function alreadyPublished(name, version) {
  const r = runCapture('npm', ['view', `${name}@${version}`, 'version', '--json']);
  return r.status === 0 && String(r.stdout).includes(version);
}

/** Human-readable size of a package directory, for the progress line. */
function dirSize(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  try { walk(dir); } catch { return 'unknown size'; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

  // download into a staging dir first: `gh run download` writes one directory
  // per artifact, while the publish tool expects dist/release/{binaries,
  // model-chunks}/. Copying explicitly also lets us refuse a half-arrived
  // release instead of publishing whatever happened to be there.
  const staging = path.join(RELEASE_DIR, '..', 'artifacts');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  console.log(`[publish] downloading artifacts of run ${runId} ...`);
  const status = run('gh', ['run', 'download', String(runId), '--dir', staging]);
  if (status !== 0) {
    console.error('[publish] gh run download failed. Is the gh CLI logged in (gh auth status)?');
    console.error('[publish] if the run has expired, re-run the build: gh workflow run release-packages.yml');
    process.exit(1);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(CHUNK_DIR, { recursive: true });

  let binaries = 0;
  let chunks = 0;
  for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(staging, entry.name);
    if (entry.name.startsWith('binaries-')) {
      // every binaries-* artifact carries dist/release/binaries/<pkg>/
      for (const pkg of packageDirs(from)) {
        const dest = path.join(BIN_DIR, path.basename(pkg));
        fs.cpSync(pkg, dest, { recursive: true });
        binaries++;
      }
    } else if (entry.name === 'model-chunks') {
      for (const pkg of packageDirs(from)) {
        const dest = path.join(CHUNK_DIR, path.basename(pkg));
        fs.cpSync(pkg, dest, { recursive: true });
        chunks++;
      }
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });

  console.log(`[publish] staged ${binaries} binary package(s) and ${chunks} chunk package(s)`);

  // The universal package is not an artifact of its own: the entry job builds
  // it from the packages it received. Rebuild it here for the same reason -
  // it needs every slot, and now they are all present.
  const uniDir = path.join(BIN_DIR, '@sys-one__laya-serve-universal');
  if (!fs.existsSync(uniDir)) {
    console.log('[publish] assembling the universal package from the staged binaries');
    try {
      run(process.execPath, [path.join(ROOT, 'tools', 'build-platform-packages.js'), 'build', '--only', 'universal']);
    } catch (err) {
      console.error(`[publish] could not assemble the universal package: ${err.message}`);
    }
  }
  if (binaries === 0 && chunks === 0) {
    console.error('[publish] nothing usable arrived - check that the run succeeded');
    process.exit(1);
  }

  // The build ran with a specific version; publishing is frequently done under
  // a different one (1.1.0-alpha.0 while the packages are still 1.1.0). npm
  // silently skips an optionalDependency whose version does not exist, so a
  // mismatch here would ship an entry package that installs nothing.
  cmdInspect();
}

/**
 * Check that everything about to be published agrees on a version.
 *
 * The artifacts were built with whatever version the workflow was told to use
 * (`gh workflow run release-packages.yml -f version=...`). If package.json has
 * moved on since, publishing them under the new number would ship an entry
 * package whose optionalDependencies point at packages that do not exist -
 * and npm silently skips a missing optional, so the install would look fine
 * and then fail to find a binary. Refusing is the only safe answer.
 */
function checkVersions() {
  const want = readMain().version;
  const problems = [];

  const seen = new Set();
  for (const [kind, dirs] of [['binary', packageDirs(BIN_DIR)], ['chunk', packageDirs(CHUNK_DIR)]]) {
    for (const dir of dirs) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      seen.add(pkg.name);
      if (pkg.version !== want) {
        problems.push(`${kind} package ${pkg.name} is ${pkg.version}, but package.json says ${want}`);
      }
    }
  }

  if (problems.length) {
    console.error('\n[publish] version mismatch - refusing to publish:');
    for (const p of problems.slice(0, 6)) console.error(`  - ${p}`);
    if (problems.length > 6) console.error(`  ... and ${problems.length - 6} more`);
    console.error(`\n[publish] the artifacts were built for one version and package.json says another.`);
    console.error(`[publish] either publish under the built version:`);
    console.error(`[publish]   npm version <the-built-version> --no-git-tag-version`);
    console.error(`[publish] or rebuild for this one:`);
    console.error(`[publish]   gh workflow run release-packages.yml -f version=${want}`);
    process.exit(1);
  }

  // the entry package must depend on exactly what we are about to publish
  const main = readMain();
  const opt = main.optionalDependencies || {};
  const declared = new Set(Object.keys(opt));
  for (const name of seen) {
    if (!declared.has(name)) problems.push(`package.json does not list ${name} as an optionalDependency`);
  }
  for (const [name, ver] of Object.entries(opt)) {
    if (ver !== want) problems.push(`package.json pins ${name} at ${ver}, expected ${want}`);
  }
  if (problems.length) {
    console.error('\n[publish] package.json does not match the staged packages:');
    for (const p of problems.slice(0, 6)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[publish] version ${want} consistent across ${seen.size} package(s) ✔`);
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
  checkVersions();
}

async function cmdPublish(args) {
  const tag = args.tag || 'alpha';
  const dryRun = args['dry-run'] === true;
  // A one-time password from an authenticator app. npm's browser flow prints a
  // URL and can exit with EOTP instead of waiting, so a code is the path that
  // always works - and it is reused for every package in this run.
  const otp = args.otp || process.env.LAYA_NPM_OTP || null;
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

  // never publish a half-matched set: npm skips a missing optionalDependency
  // silently, so a version skew ships an install that finds no binary.
  checkVersions();

  // leaf packages first: the model chunks and the platform binaries must
  // exist before the main package that depends on them.
  const order = [
    ...packageDirs(CHUNK_DIR),
    ...packageDirs(BIN_DIR),
    ROOT // the entry package last
  ];

  const total = order.length;
  console.log(`[publish] ${total} package(s) to ${dryRun ? 'check' : 'publish'}, leaf packages first.`);
  console.log('[publish] npm may ask you to authenticate (2FA). If it prints a URL, open it;');
  console.log('[publish] if it exits with EOTP instead, re-run with --otp <code> from your');
  console.log('[publish] authenticator app, or set LAYA_NPM_OTP.\n');

  const results = [];
  let done = 0;
  for (const dir of order) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.private) { results.push([pkg.name, 'skipped (private)']); continue; }

    // republishing a version is the most common failure, and npm reports it
    // with a wall of output. Checking first keeps the run readable.
    if (!dryRun && alreadyPublished(pkg.name, pkg.version)) {
      console.log(`[publish] [${++done}/${total}] ${pkg.name}@${pkg.version} is already published, skipping`);
      results.push([pkg.name, 'already published (skipped)']);
      continue;
    }

    const npmArgs = ['publish', '--tag', tag, '--access', 'public'];
    if (dryRun) npmArgs.push('--dry-run');
    if (otp) npmArgs.push('--otp', otp);

    const size = dirSize(dir);
    console.log(`\n[publish] [${++done}/${total}] ${dryRun ? 'checking' : 'uploading'} ${pkg.name}@${pkg.version} (${size}) ...`);
    const r = await runInteractive('npm', npmArgs, { cwd: dir });
    if (r.code !== 0) {
      console.error(`\n[publish] FAILED ${pkg.name}@${pkg.version} (npm exited ${r.code})`);
      console.error('[publish] stopping so you can fix it before the rest go out.');
      process.exit(1);
    }
    results.push([pkg.name, dryRun ? 'dry-run ok' : 'published']);
    console.log(`[publish] ✓ ${pkg.name}@${pkg.version}`);
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
  publish --tag alpha --otp 123456  publish, supplying the 2FA code yourself
  publish --tag latest --i-understand-latest
                                   the real release (verify the alpha first)
  publish --tag alpha --dry-run    show what would be published
`);
  }
}

main();
