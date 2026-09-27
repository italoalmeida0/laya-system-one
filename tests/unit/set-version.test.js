/**
 * set-version.js — the rule that must not be broken by accident.
 *
 * The two kinds of @sys-one package are versioned by different things:
 *   binaries - compiled from this commit, so they follow the package version
 *   chunks   - cut from the checkpoint, so they follow the MODEL version
 *
 * Getting that wrong is expensive in a way that is easy to miss: pinning the
 * chunks to a new package version republishes 235 MB of identical bytes and
 * makes every user re-download them. These tests run the real script against
 * a scratch copy of the repo, so they check the behaviour rather than a
 * re-implementation of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A throwaway copy of the files set-version touches. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-setver-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'set-version.js'), path.join(dir, 'tools', 'set-version.js'));

  const main = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  main.version = '1.1.0';
  main.optionalDependencies = {
    '@sys-one/laya-serve-linux-x64': '1.1.0',
    '@sys-one/laya-serve-universal': '1.1.0',
    '@sys-one/laya-model-chunk-00': '1.1.0',
    '@sys-one/laya-model-chunk-01': '1.1.0'
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(main, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: main.name, version: '1.1.0', lockfileVersion: 3,
    packages: { '': { name: main.name, version: '1.1.0' } }
  }, null, 2));

  // the checkpoint's own version, deliberately different from the package's
  fs.writeFileSync(path.join(dir, 'models', 'model.manifest.json'), JSON.stringify({
    modelVersion: '1.0.0',
    chunks: [{ index: 0, package: '@sys-one/laya-model-chunk-00', version: '1.0.0' }]
  }, null, 2));

  return dir;
}

function runSetVersion(dir, ...args) {
  return execFileSync(process.execPath, [path.join(dir, 'tools', 'set-version.js'), ...args], {
    cwd: dir, encoding: 'utf8'
  });
}

test('set-version: binaries follow the package, chunks follow the model', () => {
  const dir = sandbox();
  try {
    runSetVersion(dir, '1.2.0');
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

    assert.equal(main.version, '1.2.0');
    assert.equal(main.optionalDependencies['@sys-one/laya-serve-linux-x64'], '1.2.0',
      'binaries are rebuilt for this release, so they carry its version');
    assert.equal(main.optionalDependencies['@sys-one/laya-serve-universal'], '1.2.0');
    assert.equal(main.optionalDependencies['@sys-one/laya-model-chunk-00'], '1.0.0',
      'chunks are cut from the checkpoint: an unchanged model must keep its version');
    assert.equal(main.optionalDependencies['@sys-one/laya-model-chunk-01'], '1.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set-version: the model manifest is never rewritten', () => {
  const dir = sandbox();
  try {
    const before = fs.readFileSync(path.join(dir, 'models', 'model.manifest.json'), 'utf8');
    runSetVersion(dir, '9.9.9');
    const after = fs.readFileSync(path.join(dir, 'models', 'model.manifest.json'), 'utf8');
    assert.equal(after, before, 'rewriting the manifest would republish every chunk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set-version: --check reports a mismatch without writing', () => {
  const dir = sandbox();
  try {
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.throws(() => runSetVersion(dir, '--check', '1.2.0'), 'a mismatch must fail the check');
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before,
      '--check must not modify anything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set-version: rejects a version that is not semver', () => {
  const dir = sandbox();
  try {
    assert.throws(() => runSetVersion(dir, 'not-a-version'));
    assert.throws(() => runSetVersion(dir, '1.2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('preflight: chunks are checked against the model version, not the package', async () => {
  // This rule lives in three places (set-version, publish-all, preflight) and
  // the preflight was the one that got missed: publishing 1.2.0 failed with
  // 13 "pinned to 1.1.0, expected 1.2.0" errors for chunks that were correct.
  // The test calls the real exported function, not a copy of the rule.
  const { checkPackageVersions } = await import('../../tools/preflight-publish.js');
  const dir = sandbox();
  try {
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    main.version = '1.2.0';
    main.binaryVersion = '1.2.0';
    main.optionalDependencies = {
      '@sys-one/laya-serve-darwin-arm64': '1.2.0',
      '@sys-one/laya-serve-darwin-x64': '1.2.0',
      '@sys-one/laya-serve-win32-x64': '1.2.0',
      '@sys-one/laya-serve-win32-arm64': '1.2.0',
      '@sys-one/laya-serve-linux-x64': '1.2.0',
      '@sys-one/laya-serve-linux-arm64': '1.2.0',
      '@sys-one/laya-serve-universal': '1.2.0',
      '@sys-one/laya-model-chunk-00': '1.0.0',
      '@sys-one/laya-model-chunk-01': '1.0.0'
    };
    // the sandbox manifest declares modelVersion 1.0.0 and 2 chunks
    fs.writeFileSync(path.join(dir, 'models', 'model.manifest.json'), JSON.stringify({
      modelVersion: '1.0.0', chunkCount: 2,
      chunks: [
        { index: 0, package: '@sys-one/laya-model-chunk-00', version: '1.0.0' },
        { index: 1, package: '@sys-one/laya-model-chunk-01', version: '1.0.0' }
      ]
    }, null, 2));

    assert.deepEqual(checkPackageVersions(main, dir), [],
      'binaries at the package version and chunks at the model version must pass');

    // and the failure it used to produce must still be caught
    const wrong = structuredClone(main);
    wrong.optionalDependencies['@sys-one/laya-model-chunk-00'] = '1.2.0';
    const problems = checkPackageVersions(wrong, dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /chunk-00 is pinned to 1\.2\.0, expected the model version 1\.0\.0/);

    // a binary at the wrong version is still an error
    const badBin = structuredClone(main);
    badBin.optionalDependencies['@sys-one/laya-serve-linux-x64'] = '1.1.0';
    assert.match(checkPackageVersions(badBin, dir)[0], /binaryVersion is 1\.2\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
