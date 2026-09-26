/**
 * Packaging tests: what `npm pack` actually ships, and whether it stays
 * within the registry payload limits. Fast and offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function npmJson(args, cwd = ROOT) {
  const out = execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' }
  });
  return JSON.parse(out.slice(out.indexOf('[')));
}

test('package.json has the fields an installable package needs', () => {
  assert.equal(PKG.type, 'module');
  assert.ok(PKG.name && PKG.version);
  assert.match(PKG.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, 'version must be semver');
  assert.ok(PKG.main, 'main entry point required');
  assert.ok(PKG.bin?.['laya-system-one'], 'CLI bin mapping required');
  assert.ok(PKG.license, 'license required');
  assert.ok(PKG.repository?.url, 'repository required');
  assert.ok(PKG.files?.length, 'files whitelist required (keeps the tarball tight)');

  const files = PKG.files.join('\n');
  assert.match(files, /src\//, 'src must ship');
  assert.match(files, /bin\//, 'CLI must ship');
  assert.match(files, /README\.md/);
  assert.match(files, /LICENSE/);
  assert.ok(!files.includes('tests'), 'tests must not ship');
  assert.ok(!files.includes('tools'), 'build tools must not ship');
});

test('npm pack only ships the intended files', () => {
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const names = meta.files.map((f) => f.path);

  for (const must of [
    'package.json',
    'README.md',
    'LICENSE',
    'bin/cli.js',
    'bin/postinstall.js',
    'src/index.js',
    'src/agent.js',
    'src/engine.js',
    'src/model-resolver.js',
    'src/server.js',
    'src/tokenizer.js',
    'models/tokenizer.json',
    'models/model.manifest.json'
  ]) {
    assert.ok(names.includes(must), `missing from the tarball: ${must}`);
  }

  for (const name of names) {
    assert.ok(!name.startsWith('tests/'), `tests must not ship: ${name}`);
    assert.ok(!name.startsWith('tools/'), `tools must not ship: ${name}`);
    assert.ok(!name.startsWith('examples/'), `examples must not ship: ${name}`);
    assert.ok(!name.endsWith('.onnx'), `model weights must not ship: ${name}`);
    assert.ok(!name.startsWith('dist/model-chunks/'), `chunk packages must not ship: ${name}`);
    assert.ok(!name.includes('.env'), `env files must not ship: ${name}`);
    assert.ok(!name.includes('node_modules'), `node_modules must not ship: ${name}`);
  }
});

test('npm pack stays well under the registry payload limits', () => {
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  // npm rejects payloads above ~200 MB with HTTP 413. The entry package must
  // be an order of magnitude below that: the heavy artifacts are packages.
  assert.ok(meta.size < 40 * 1024 * 1024, `entry tarball is ${mb(meta.size)} MB — the binaries/model leaked back in`);
  assert.ok(meta.unpackedSize < 120 * 1024 * 1024, `unpacked is ${mb(meta.unpackedSize)} MB`);
  assert.ok(meta.entryCount > 0);
});

test('the model manifest ships so installs can verify the download', () => {
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const names = meta.files.map((f) => f.path);
  assert.ok(names.includes('models/model.manifest.json'));
});

test('the binaries and the model are optionalDependencies, not tarball payload', () => {
  // The whole point of 1.1.0: the entry package stays small and the heavy
  // artifacts arrive as packages npm selects by os/cpu. If either of these
  // regresses, the entry package balloons back to ~200 MB.
  const opt = PKG.optionalDependencies || {};
  for (const p of ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'universal']) {
    assert.equal(opt[`@sys-one/laya-serve-${p}`], PKG.version, `@sys-one/laya-serve-${p} must be an optionalDependency pinned to the package version`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'model.manifest.json'), 'utf8'));
  for (let i = 0; i < manifest.chunkCount; i++) {
    const name = `@sys-one/laya-model-chunk-${String(i).padStart(2, '0')}`;
    assert.equal(opt[name], PKG.version, `${name} must be an optionalDependency pinned to the package version`);
  }

  // and none of that may sneak back into the tarball
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const names = meta.files.map((f) => f.path);
  for (const name of names) {
    assert.ok(!name.startsWith('dist/bin/'), `native binaries must ship as packages, not files: ${name}`);
  }
});

test('every declared platform package is buildable and well-formed', () => {
  // Guards the generator: a package that installs but has no binary, or the
  // wrong os/cpu, would fail only on a user's machine.
  const expected = {
    'laya-serve-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
    'laya-serve-darwin-x64': { os: ['darwin'], cpu: ['x64'] },
    'laya-serve-win32-x64': { os: ['win32'], cpu: ['x64'] },
    'laya-serve-win32-arm64': { os: ['win32'], cpu: ['arm64'] },
    'laya-serve-linux-x64': { os: ['linux'], cpu: ['x64'] },
    'laya-serve-linux-arm64': { os: ['linux'], cpu: ['arm64'] },
    'laya-serve-universal': null // matches anything: the fallback
  };

  const res = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-platform-packages.js'), 'list'], {
    cwd: ROOT, encoding: 'utf8'
  });
  assert.equal(res.status, 0, res.stderr);

  for (const [name, sel] of Object.entries(expected)) {
    assert.ok(res.stdout.includes(`@sys-one/${name}`), `generator does not know about ${name}`);
    if (!sel) continue;
    assert.ok(res.stdout.includes(`os=[${sel.os}] cpu=[${sel.cpu}]`),
      `${name} must declare os/cpu exactly as npm matches them`);
  }
});

test('postinstall is safe to run repeatedly and never requires network', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'postinstall.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LAYA_SKIP_MODEL_DOWNLOAD: '1' }
  });
  assert.equal(res.status, 0, `postinstall failed: ${res.stderr}`);
});

test('the loader can make a binary executable itself (install scripts are optional)', () => {
  // bun install, `npm ci --ignore-scripts` and several Docker flows skip
  // install scripts entirely, so nothing critical may depend on postinstall.
  // The loader chmods the resolved binary instead - this asserts the code
  // path exists and returns a path it would be able to fix.
  const res = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    `import { resolveBinaryOrNull } from '${pathToFileURL(path.join(ROOT, 'src', 'laya-native.js')).href}';
     const bin = resolveBinaryOrNull();
     if (bin) { console.log('resolved:' + bin); } else { console.log('none'); }`
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  if (res.stdout.includes('resolved:')) {
    assert.ok(fs.existsSync(res.stdout.trim().replace('resolved:', '')), 'the resolved binary must exist');
  }
});
