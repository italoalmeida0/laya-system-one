#!/usr/bin/env node
/**
 * install-rehearsal.js — install the package the way a user will, offline.
 *
 * This is the rehearsal that runs before publishing, and it exists because
 * the interesting failures only show up during a real install: a package that
 * npm refuses to select, a binary that is not executable, a chunk that does
 * not arrive, a loader that cannot find what it expects.
 *
 * It builds a throwaway project, serves the freshly built @sys-one packages
 * from a LOCAL registry (a tiny HTTP server speaking just enough npm registry
 * protocol, no network, nothing published), points npm at it, installs
 * laya-system-one, and then actually loads the library and runs inference -
 * once as a Node process and once as a Bun process if Bun is available.
 *
 * The platform is a parameter, so the same rehearsal proves the selection for
 * every platform we ship (that is how a linux dev checks what a Windows user
 * will get):
 *
 *   node tools/install-rehearsal.js                       # this machine
 *   node tools/install-rehearsal.js --os=win32 --cpu=x64  # pretend
 *   node tools/install-rehearsal.js --all                 # every platform
 *   node tools/install-rehearsal.js --runtime=node,bun
 *
 * Requires the packages to be built first:
 *   node tools/build-platform-packages.js build && ... pack
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'dist', 'release');
const BIN_PKGS = path.join(RELEASE, 'binaries');
const CHUNK_PKGS = path.join(RELEASE, 'model-chunks');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};

const MAIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// The npm CLI entry point, run through node directly: spawning "npm" needs a
// shell on Windows and that wrapper has hung on us before.
const NPM_CLI = (() => {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'npm-cli.js';
})();
const VERSION = MAIN.version;

const PLATFORMS = {
  'linux-x64': { os: 'linux', cpu: 'x64', expect: 'laya-serve-linux-x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', expect: 'laya-serve-linux-arm64' },
  'win32-x64': { os: 'win32', cpu: 'x64', expect: 'laya-serve-win32-x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', expect: 'laya-serve-win32-arm64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', expect: 'laya-serve-darwin-arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', expect: 'laya-serve-darwin-x64' }
};

/* ----------------------------- fake registry ----------------------------- */

/**
 * Serve every built package over the npm registry protocol npm needs:
 *   GET /<name>                    -> packument {"versions":{"<v>":{...}}}
 *   GET /<name>/-/<file>.tgz       -> the tarball bytes
 * Scoped names arrive URL-encoded (%2f), which npm does - handle both.
 */
async function startRegistry() {
  const packages = new Map(); // name@version -> tarball path

  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = path.join(dir, entry.name, 'package.json');
      if (!fs.existsSync(meta)) continue;
      const pkg = JSON.parse(fs.readFileSync(meta, 'utf8'));
      packages.set(`${pkg.name}@${pkg.version}`, { dir: path.join(dir, entry.name), pkg });
    }
  };
  collect(BIN_PKGS);
  collect(CHUNK_PKGS);

  // the entry package itself, packed on the fly so the rehearsal installs the
  // real tarball npm would receive (files whitelist and all)
  const packOut = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-entry-pack-'));
  const pack = spawnSync('npm', ['pack', '--pack-destination', packOut], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (pack.status !== 0) throw new Error(`npm pack of the entry package failed: ${pack.stderr}`);
  const entryTgz = path.join(packOut, fs.readdirSync(packOut).find((f) => f.endsWith('.tgz')));
  packages.set(`${MAIN.name}@${VERSION}`, { tgz: entryTgz, pkg: MAIN });

  let port = 0;
  const server = http.createServer((req, res) => {
    const raw = (req.url || '').split('?')[0];
    const decoded = decodeURIComponent(raw);

    // tarball: /<name>/-/<file>.tgz   (name may be @scope/name)
    const tarMatch = /^\/(.+?)\/-\/([^/]+\.tgz)$/.exec(decoded);
    if (tarMatch) {
      const name = tarMatch[1];
      const hit = [...packages.entries()].find(([key, v]) => v.pkg.name === name && key.endsWith(`@${v.pkg.version}`));
      if (!hit) { res.writeHead(404); res.end('no such package'); return; }
      const { tgz, dir } = hit[1];
      let body;
      if (tgz) {
        body = fs.readFileSync(tgz);
      } else {
        body = makeTarball(dir, hit[1].pkg);
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      res.end(body);
      return;
    }

    // packument: /<name>
    const name = decoded.replace(/^\//, '');
    const versions = {};
    for (const [key, v] of packages) {
      if (v.pkg.name !== name) continue;
      versions[v.pkg.version] = {
        name: v.pkg.name,
        version: v.pkg.version,
        // npm reads these to decide os/cpu selection locally
        os: v.pkg.os,
        cpu: v.pkg.cpu,
        optionalDependencies: v.pkg.optionalDependencies,
        dist: {
          tarball: `http://127.0.0.1:${port}/${v.pkg.name}/-/${v.pkg.name.split('/').pop()}-${v.pkg.version}.tgz`
        }
      };
    }
    if (Object.keys(versions).length === 0) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, 'dist-tags': { [VERSION.includes('-') ? 'alpha' : 'latest']: VERSION }, versions }));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.keepAliveTimeout = 5000;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Minimal npm-compatible tarball (gzipped tar with package/ prefix). */
function makeTarball(dir, pkg) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) walk(full, `${rel}/`);
      else entries.push([rel, fs.readFileSync(full)]);
    }
  };
  walk(dir, 'package/');
  const tar = buildTar(entries);
  return zlib.gzipSync(tar);
}

function buildTar(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 99), 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(header, data);
    const pad = 512 - (data.length % 512);
    if (pad !== 512) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/* ------------------------------- helpers -------------------------------- */

/** Run a command asynchronously and resolve with {code, stdout, stderr}. */
function runAsync(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/* -------------------------------- checks -------------------------------- */

async function checkProject(label, dir, platform, runtime, registryUrl) {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const nm = path.join(dir, 'node_modules', '@sys-one');
  const installed = fs.existsSync(nm) ? fs.readdirSync(nm) : [];

  // 1) the right platform package, and only it among the specific ones
  const specific = Object.keys(PLATFORMS).map((k) => PLATFORMS[k].expect);
  const gotSpecific = installed.filter((n) => specific.includes(n));
  record(`selects exactly one platform package`, gotSpecific.length === 1,
    gotSpecific.join(',') || 'none');
  record(`and it is ${platform.expect}`, gotSpecific[0] === platform.expect, gotSpecific[0] || '-');

  // 2) the model chunks arrived
  const chunks = installed.filter((n) => n.startsWith('laya-model-chunk-'));
  record('model chunks installed', chunks.length >= 13, `${chunks.length} package(s)`);

  // 3) a binary is present and executable
  const pkgDir = path.join(nm, platform.expect);
  const slot = platform.os === 'win32' ? platform.expect.replace('laya-serve-', '') : platform.expect.replace('laya-serve-', '');
  const binDir = path.join(pkgDir, 'bin', slot);
  let bin = null;
  if (fs.existsSync(binDir)) {
    bin = fs.readdirSync(binDir).map((f) => path.join(binDir, f))[0] || null;
  }
  record('binary present in the package', Boolean(bin), bin ? path.relative(dir, bin) : '-');
  if (bin && platform.os !== 'win32') {
    const mode = fs.statSync(bin).mode;
    record('binary is executable', (mode & 0o111) !== 0, `mode ${(mode & 0o777).toString(8)}`);
  }

  // 4) the whole thing actually runs, in this runtime
  const script = `
    import { Laya } from 'laya-system-one';
    const tLoad = Date.now();
    const laya = await Laya.load({ backend: 'native' });
    const loadMs = Date.now() - tLoad;
    // time the questions separately: a total that mixes model load with
    // inference reads as "inference is slow" when it is really startup.
    const tQ = Date.now();
    const questions = {
      department: { type: 'choice', instructions: 'Which department should handle this?',
        criteria: { billing: 'refunds and invoices', tech: 'bugs', sales: 'upgrades' } },
      churn: { type: 'noul', instructions: 'Is the user at churn risk?', threshold: 0.5 }
    };
    const prompts = [
      'We were billed twice on the March invoice and want a refund.',
      'The app crashes with a segfault when I open the settings page.',
      'Fui cobrado em duplicidade na minha fatura e quero reembolso.',
      'Me cobraron dos veces en mi factura y quiero un reembolso.',
      'Can I upgrade my plan to the enterprise tier next month?',
      'Your service has been down for six hours and nobody answers.',
      'I love the product, but the invoice address needs updating.',
      'Need help resetting my password, the email never arrives.',
      'The refund was promised last week but has not arrived yet.',
      'Do you support SSO with SAML for our organization?'
    ];
    const answers = [];
    for (const p of prompts) { answers.push((await laya.predict(p, questions)).answers.department.choice); }
    const questionsMs = Date.now() - tQ;
    console.log('ANSWERS:' + JSON.stringify(answers));
    console.log('LOAD_MS:' + loadMs);
    console.log('QUESTIONS_MS:' + questionsMs);
    console.log('PER_QUESTION_MS:' + (questionsMs / prompts.length).toFixed(0));
    await laya.close();
    process.exit(0);
  `;
  fs.writeFileSync(path.join(dir, 'run.mjs'), script);

  const isBun = runtime === 'bun';
  const runner = isBun ? 'bun' : process.execPath;
  const r = await runAsync(runner, ['run.mjs'], {
    cwd: dir,
    env: { ...process.env, npm_config_registry: registryUrl, LAYA_SKIP_MODEL_DOWNLOAD: '1' }
  });

  if (r.code !== 0) {
    record(`${runtime} ran 10 questions`, false, (r.stderr || r.stdout || '').split('\n').slice(-3).join(' ').slice(0, 200));
    return results;
  }
  const line = (prefix) => (r.stdout || '').split('\n').find((l) => l.startsWith(prefix)) || '';
  const answersLine = line('ANSWERS:');
  const answers = answersLine ? JSON.parse(answersLine.slice(8)) : [];
  // load and inference are reported separately: a single total makes startup
  // look like slow inference
  const loadMs = line('LOAD_MS:').slice(8);
  const perQ = line('PER_QUESTION_MS:').slice(16);
  record(`${runtime} ran 10 questions`, answers.length === 10,
    answers.length ? `load ${loadMs}ms, ${perQ}ms/question` : `no answers (${r.stdout.slice(-160)})`);
  record('answers are sane', answers[0] === 'billing' && answers[1] === 'tech',
    `first two: ${answers[0]}, ${answers[1]}`);
  return results;
}

/* --------------------------------- main --------------------------------- */

async function main() {
  if (!fs.existsSync(BIN_PKGS) || fs.readdirSync(BIN_PKGS).length === 0) {
    console.error('[rehearsal] no built packages. Run:\n  npm run pkgs:build\n  npm run pkgs:pack');
    process.exit(1);
  }

  const hasBun = spawnSync('bun', ['--version'], { shell: process.platform === 'win32' }).status === 0;
  const runtimes = val('runtime', hasBun ? 'node,bun' : 'node').split(',').filter(Boolean);

  let targets;
  if (has('--all')) {
    targets = Object.keys(PLATFORMS).map((k) => ({ label: k, ...PLATFORMS[k] }));
  } else if (val('os') && val('cpu')) {
    const key = `${val('os')}-${val('cpu')}`;
    targets = [{ label: key, os: val('os'), cpu: val('cpu'), expect: PLATFORMS[key]?.expect || `laya-serve-${key}` }];
  } else {
    const key = `${process.platform}-${process.arch}`;
    targets = [{ label: key, os: process.platform, cpu: process.arch, expect: PLATFORMS[key]?.expect || `laya-serve-${key}` }];
  }

  console.log('[rehearsal] starting the local registry...');
  const registry = await startRegistry();
  console.log(`[rehearsal] registry at ${registry.url}`);
  console.log(`[rehearsal] runtimes: ${runtimes.join(', ')}`);

  let failures = 0;
  for (const target of targets) {
    console.log(`\n[rehearsal] === ${target.label} ===`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `laya-rehearsal-${target.label}-`));
    try {
      // only the entry package is requested: everything else must arrive
      // through optionalDependencies, exactly like a real install
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'rehearsal', version: '0.0.0', private: true,
        dependencies: { [MAIN.name]: VERSION }
      }, null, 2));

      // userconfig is pointed at an empty file so the developer's global
      // ~/.npmrc (auth tokens, corporate mirrors) cannot leak into the test
      fs.writeFileSync(path.join(dir, 'empty.npmrc'), '');
      fs.writeFileSync(path.join(dir, '.npmrc'), `registry=${registry.url}\n`);
      fs.writeFileSync(path.join(dir, 'user.npmrc'), '');

      console.log('  installing...');
      // async: the registry runs in THIS process, so a blocking spawnSync
      // would deadlock npm waiting for metadata it can never receive.
      const inst = await runAsync(process.execPath, [NPM_CLI,
        'install', '--no-audit', '--no-fund',
        `--registry=${registry.url}`,
        `--cache=${path.join(dir, '.npm-cache')}`,
        `--userconfig=${path.join(dir, 'user.npmrc')}`,
        `--os=${target.os}`, `--cpu=${target.cpu}`
      ], { cwd: dir, env: { ...process.env, npm_config_registry: registry.url } });

      if (inst.code !== 0) {
        console.log(`  FAIL install errored:\n${(inst.stderr || '').split('\n').slice(0, 8).join('\n')}`);
        failures++;
        continue;
      }

      for (const runtime of runtimes) {
        // the platform package we expect must be a native binary package, and
        // it can only be executed when it matches the machine we are on.
        const native = target.os === process.platform && (target.cpu === process.arch || (process.arch === 'x64' && target.cpu === 'x64'));
        if (!native && runtime === 'node') {
          // wrong platform for this CPU: just check what npm selected
          const nm = path.join(dir, 'node_modules', '@sys-one');
          const installed = fs.existsSync(nm) ? fs.readdirSync(nm) : [];
          const specific = Object.keys(PLATFORMS).map((k) => PLATFORMS[k].expect).filter((n) => installed.includes(n));
          const ok = specific.length === 1 && specific[0] === target.expect;
          console.log(`    ${ok ? 'ok  ' : 'FAIL'} selects ${target.expect} (not runnable here)`);
          console.log(`    ${installed.filter((n) => n.startsWith('laya-model-chunk-')).length >= 13 ? 'ok  ' : 'FAIL'} model chunks installed`);
          if (!ok) failures++;
          continue;
        }
        const results = await checkProject(target.label, dir, target, runtime, registry.url);
        if (results.includes(false)) failures++;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  registry.close();
  console.log(`\n[rehearsal] ${failures === 0 ? 'the install a user will get works ✔' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[rehearsal] ${err.stack || err.message}`);
  process.exit(1);
});
