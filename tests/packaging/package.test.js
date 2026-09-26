/**
 * Packaging tests: what `npm pack` actually ships, and whether it stays
 * within the registry payload limits. Fast and offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('npm pack stays within the registry payload limits', () => {
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  // npm rejects payloads above ~200 MB with HTTP 413; keep real headroom.
  assert.ok(meta.size < 150 * 1024 * 1024, `tarball is ${mb(meta.size)} MB — too close to the registry limit`);
  assert.ok(meta.unpackedSize < 400 * 1024 * 1024, `unpacked is ${mb(meta.unpackedSize)} MB`);
  assert.ok(meta.entryCount > 0);
});

test('the model manifest ships so installs can verify the download', () => {
  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const names = meta.files.map((f) => f.path);
  assert.ok(names.includes('models/model.manifest.json'));
});

test('postinstall is safe to run repeatedly', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'postinstall.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LAYA_SKIP_MODEL_DOWNLOAD: '1' }
  });
  assert.equal(res.status, 0, `postinstall failed: ${res.stderr}`);
});

test('all platform binaries ship when dist/bin is present', () => {
  const REQUIRED = [
    'dist/bin/win32-x64/laya-serve.exe',
    'dist/bin/win32-arm64/laya-serve.exe',
    'dist/bin/linux-x64/laya-serve',
    'dist/bin/linux-arm64/laya-serve',
    'dist/bin/darwin-arm64/laya-serve',
    'dist/bin/linux-x64-musl/laya-serve.bundle',
    'dist/bin/linux-arm64-musl/laya-serve.bundle'
  ];
  const anyOnDisk = REQUIRED.some((p) => fs.existsSync(path.join(ROOT, p)));
  if (!anyOnDisk) {
    // fresh checkout without build outputs (CI before build-binaries runs)
    return;
  }

  const [meta] = npmJson(['pack', '--dry-run', '--json']);
  const names = new Set(meta.files.map((f) => f.path));
  for (const bin of REQUIRED) {
    assert.ok(names.has(bin), `native binary missing from the tarball: ${bin}`);
  }
});
