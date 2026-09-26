/**
 * Fresh-install smoke test — the "does it work for someone else" check.
 *
 * Packs the project, installs the tarball into an empty directory and runs
 * the library + CLI from there. Slow and network-heavy (npm installs the
 * runtime deps), so it lives in its own folder: run it with
 *   npm run test:install
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeTempDir, rmrf } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('fresh install: packed tarball installs and runs elsewhere', { timeout: 1500000 }, () => {
  const dir = makeTempDir('laya-install-');
  let tgz = null;
  try {
    // 1) build the tarball
    const out = execFileSync('npm', ['pack', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_fund: 'false' }
    });
    const [meta] = JSON.parse(out.slice(out.indexOf('[')));
    tgz = path.join(ROOT, meta.filename);
    assert.ok(fs.existsSync(tgz), 'npm pack must produce a tarball');

    // 2) install it into a pristine project
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'laya-install-test', version: '1.0.0', private: true })
    );
    execFileSync('npm', ['install', tgz, '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: dir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 900000
    });

    // 3) the library is importable
    fs.writeFileSync(path.join(dir, 'probe.mjs'), `
      import { Laya, serve } from 'laya-system-one';
      if (typeof Laya !== 'function') { console.error('Laya export missing'); process.exit(1); }
      if (typeof serve !== 'function') { console.error('serve export missing'); process.exit(1); }
      console.log('IMPORT_OK');
    `);
    const res = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, `import failed: ${res.stderr}`);
    assert.match(res.stdout, /IMPORT_OK/);

    // 4) the CLI is linked and answers --version/--help
    const binPath = path.join(
      dir, 'node_modules', '.bin',
      process.platform === 'win32' ? 'laya-system-one.cmd' : 'laya-system-one'
    );
    assert.ok(fs.existsSync(binPath), 'the laya-system-one binary must be linked');

    const version = spawnSync(binPath, ['--version'], {
      cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000
    });
    assert.equal(version.status, 0, `--version failed: ${version.stderr}`);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/, `unexpected --version output: ${version.stdout}`);

    const help = spawnSync(binPath, ['--help'], {
      cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000
    });
    assert.equal(help.status, 0, `--help failed: ${help.stderr}`);
    assert.match(help.stdout, /\/v1\/systemone/);

    // 5) the native binary shipped with the package is usable from there
    const plat = os.platform();
    const arch = os.arch() === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64'];
    const exe = plat === 'win32' ? 'laya-serve.exe' : 'laya-serve';
    const candidates = arch.map((a) => path.join(
      dir, 'node_modules', 'laya-system-one', 'dist', 'bin', `${plat}-${a}`, exe
    ));
    assert.ok(
      candidates.some((p) => fs.existsSync(p)),
      `native binary missing from the installed package (tried: ${candidates.join(', ')})`
    );
  } finally {
    rmrf(dir);
    if (tgz && fs.existsSync(tgz)) fs.rmSync(tgz, { force: true });
    const leftovers = path.join(ROOT, `${PKG.name}-${PKG.version}.tgz`);
    if (fs.existsSync(leftovers)) fs.rmSync(leftovers, { force: true });
  }
});
