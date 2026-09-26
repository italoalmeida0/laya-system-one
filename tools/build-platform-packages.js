#!/usr/bin/env node
/**
 * build-platform-packages.js — generate the per-platform npm packages.
 *
 * The main package no longer ships 150+ MB of binaries for every platform.
 * Instead each platform's `laya-serve` lives in its own tiny package, listed
 * as an `optionalDependencies` of `laya-system-one`. npm picks the matching
 * one at install time from the `os` / `cpu` fields and silently skips the
 * rest, so a user downloads exactly one binary.
 *
 * Layout choice (verified against how npm actually works):
 *   - `os` and `cpu` filter reliably (esbuild/SWC/Rollup rely on this).
 *   - `libc` does NOT: it is undocumented-until-recently, accepts both
 *     string and array forms, and real packages (sharp) have shipped bugs
 *     where `--libc=glibc` installs the musl build too. So we never rely on
 *     it: the glibc and musl builds of one Linux arch travel TOGETHER in a
 *     single package and the loader picks the right file at runtime.
 *
 *   @sys-one/laya-serve-darwin-arm64   os=darwin  cpu=arm64   (laya-serve)
 *   @sys-one/laya-serve-darwin-x64     os=darwin  cpu=x64     (laya-serve)
 *   @sys-one/laya-serve-win32-x64      os=win32   cpu=x64     (laya-serve.exe)
 *   @sys-one/laya-serve-win32-arm64    os=win32   cpu=arm64   (laya-serve.exe)
 *   @sys-one/laya-serve-linux-x64      os=linux   cpu=x64     (glibc + musl)
 *   @sys-one/laya-serve-linux-arm64    os=linux   cpu=arm64   (glibc + musl)
 *   @sys-one/laya-serve-universal      (no os/cpu)            (every binary)
 *
 * The universal package is the "cannot tell what this is" safety net: if a
 * platform matches none of the specific packages (odd libc, unknown arch,
 * a distro npm mismatches), npm installs the universal one instead.
 *
 *   node tools/build-platform-packages.js build [--version 1.1.0]
 *   node tools/build-platform-packages.js pack  [--out dist/pkgs]
 *   node tools/build-platform-packages.js list
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'dist', 'bin');
const OUT_DIR = path.join(ROOT, 'dist', 'release', 'binaries');

const SCOPE = '@sys-one';
const REPO = {
  type: 'git',
  url: 'git+https://github.com/italoalmeida0/laya-system-one.git'
};

/**
 * One entry per platform package. `files` lists the binary artifacts that
 * package ships, relative to dist/bin/<slot>/.
 */
const PACKAGES = [
  {
    name: `${SCOPE}/laya-serve-darwin-arm64`,
    os: ['darwin'], cpu: ['arm64'],
    source: 'darwin-arm64',
    files: ['laya-serve']
  },
  {
    name: `${SCOPE}/laya-serve-darwin-x64`,
    os: ['darwin'], cpu: ['x64'],
    source: 'darwin-x64',
    files: ['laya-serve', 'libonnxruntime.dylib']
  },
  {
    name: `${SCOPE}/laya-serve-win32-x64`,
    os: ['win32'], cpu: ['x64'],
    source: 'win32-x64',
    files: ['laya-serve.exe']
  },
  {
    name: `${SCOPE}/laya-serve-win32-arm64`,
    os: ['win32'], cpu: ['arm64'],
    source: 'win32-arm64',
    files: ['laya-serve.exe']
  },
  {
    // glibc AND musl together: npm cannot select on libc reliably (see the
    // header). The JS loader picks laya-serve vs laya-serve.bundle at runtime.
    name: `${SCOPE}/laya-serve-linux-x64`,
    os: ['linux'], cpu: ['x64'],
    source: ['linux-x64', 'linux-x64-musl'],
    files: ['laya-serve', 'laya-serve.bundle']
  },
  {
    name: `${SCOPE}/laya-serve-linux-arm64`,
    os: ['linux'], cpu: ['arm64'],
    source: ['linux-arm64', 'linux-arm64-musl'],
    files: ['laya-serve', 'laya-serve.bundle']
  },
  {
    // Last resort: every binary, for whatever the specific packages missed.
    //
    // npm's os/cpu lists are AND-ed with per-value exclusion (`!linux` means
    // "not linux"), so the complement of the six packages cannot be spelled
    // out directly - verified by experiment, os:['!darwin','!win32','!linux']
    // installs nowhere. The workable shape is the other way round: list the
    // exotic cpus and the extra OSes explicitly, so this package is skipped
    // on every target a specific package already covers (x64/arm64 on
    // darwin/win32/linux) and installs on the rest (ppc64, s390x, riscv64,
    // freebsd, ...). Verified: linux/ppc64 selects it, linux/x64 does not.
    //
    // `npm install --omit=optional` opts out entirely; the bundled wasm
    // engine then keeps the machine running.
    name: `${SCOPE}/laya-serve-universal`,
    os: ['darwin', 'win32', 'linux', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix'],
    cpu: ['ppc64', 'ppc64le', 's390x', 'riscv64', 'ia32', 'loong64', 'mips', 'mips64', 'mips64el', 'arm', 'armel'],
    source: null, // copies every slot
    files: null
  }
];

const ALL_SOURCES = fs.existsSync(BIN_DIR)
  ? fs.readdirSync(BIN_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function packageJsonFor(pkg, version) {
  const json = {
    name: pkg.name,
    version,
    description: `Bundled laya-serve native binary for ${pkg.source === null ? 'every platform' : String(pkg.source)} (laya-system-one)`,
    license: 'Apache-2.0',
    repository: REPO,
    homepage: 'https://github.com/italoalmeida0/laya-system-one#readme',
    // pure data + a prebuilt executable: never run code on install
    scripts: {},
    keywords: ['laya', 'laya-serve', 'native', 'binary']
  };
  if (pkg.os) json.os = pkg.os;
  if (pkg.cpu) json.cpu = pkg.cpu;
  json.files = ['bin/', 'README.md', 'LICENSE'];
  return json;
}

function readmeFor(pkg) {
  const where = pkg.source === null
    ? 'every platform we build for'
    : [].concat(pkg.source).join(' and ');
  return `# ${pkg.name}

Prebuilt \`laya-serve\` binary for **${where}**.

This package exists so \`laya-system-one\` can install only the binary your
machine needs instead of all of them. You do not install it directly — run
\`npm install laya-system-one\` and npm selects the right one through
\`optionalDependencies\` + the \`os\`/\`cpu\` fields.

The binary is the self-contained Rust inference server (Axum + tokenizers +
ONNX Runtime). Nothing is compiled or downloaded at install time.

License: Apache-2.0. See the main package for documentation.
`;
}

function copyIfExists(src, destDir) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  return true;
}

/**
 * Stage one slot into <pkgDir>/bin/<slot>/. Every platform package uses the
 * same layout (including the universal one), so the JS loader has a single
 * shape to look for: bin/<slot>/<file>.
 */
function stageSlots(slots, pkgDir) {
  const written = [];
  for (const slot of slots) {
    const slotDir = path.join(BIN_DIR, slot);
    if (!fs.existsSync(slotDir)) continue;
    const dest = path.join(pkgDir, 'bin', slot);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(slotDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue; // leftover lib/ dirs never ship
      const out = path.join(dest, entry.name);
      fs.copyFileSync(path.join(slotDir, entry.name), out);
      fs.chmodSync(out, 0o755);
      written.push(path.relative(pkgDir, out));
    }
  }
  return written;
}

function cmdBuild(args) {
  const version = args.version || '1.1.0';
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let built = 0;
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(OUT_DIR, pkg.name.replace('/', '__'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(packageJsonFor(pkg, version), null, 2) + '\n');
    fs.writeFileSync(path.join(pkgDir, 'README.md'), readmeFor(pkg));
    const license = path.join(ROOT, 'LICENSE');
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(pkgDir, 'LICENSE'));

    const slots = pkg.source === null ? ALL_SOURCES : [].concat(pkg.source);
    const staged = stageSlots(slots, pkgDir);

    const exists = staged.length > 0;
    console.log(`[pkgs] ${exists ? 'ok  ' : 'SKIP'} ${pkg.name.padEnd(38)} ${staged.length} file(s)`);
    if (staged.length) built++;
  }
  console.log(`\n[pkgs] ${built}/${PACKAGES.length} packages materialised in ${path.relative(ROOT, OUT_DIR)}`);
  console.log('[pkgs] skipping packages whose binary is not in dist/bin is expected on a partial build.');
}

function cmdPack(args) {
  const outDir = path.resolve(ROOT, args.out || path.join('dist', 'release', 'tarballs'));
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(OUT_DIR)) {
    console.error('[pkgs] run `node tools/build-platform-packages.js build` first');
    process.exit(1);
  }
  let packed = 0;
  for (const dir of fs.readdirSync(OUT_DIR)) {
    const full = path.join(OUT_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const name = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8')).name;
    // An empty package would install and then fail at runtime: a missing
    // binary means the release build did not produce it, so never ship it.
    const binDir = path.join(full, 'bin');
    if (!fs.existsSync(binDir) || fs.readdirSync(binDir).length === 0) {
      console.log(`[pkgs] skip empty ${name} (no binary staged)`);
      continue;
    }
    const r = spawnSync('npm', ['pack', '--pack-destination', outDir], { cwd: full, encoding: 'utf8', shell: true });
    if (r.status !== 0) {
      console.error(`[pkgs] npm pack failed for ${name}:\n${r.stderr}`);
      process.exit(1);
    }
    console.log(`[pkgs] packed ${name}`);
    packed++;
  }
  console.log(`[pkgs] ${packed} tarball(s) in ${path.relative(ROOT, outDir)}`);
}

function cmdList() {
  console.log('platform packages (optionalDependencies of laya-system-one):\n');
  for (const pkg of PACKAGES) {
    const sel = pkg.os ? `os=[${pkg.os}] cpu=[${pkg.cpu}]` : 'os/cpu: any (universal fallback)';
    console.log(`  ${pkg.name.padEnd(38)} ${sel}`);
  }
  console.log('\ndist/bin slots present: ' + (ALL_SOURCES.join(', ') || '(none)'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'list';
  if (cmd === 'build') cmdBuild(args);
  else if (cmd === 'pack') cmdPack(args);
  else if (cmd === 'list') cmdList();
  else {
    console.error(`unknown command: ${cmd}\nusage: build-platform-packages.js [build|pack|list]`);
    process.exit(1);
  }
}

main();
