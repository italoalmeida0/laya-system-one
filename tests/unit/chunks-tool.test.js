/**
 * Round-trip tests for the model-chunk distribution pipeline
 * (tools/model-chunks.js + assembleFromRegistry): the mechanism that keeps
 * the 324 MB model entirely on npm. Uses a small fake model and a local
 * HTTP server that mimics the npm registry — fully offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assembleFromRegistry, sha256File, extractTgz, tarballUrl } from '../../src/model-resolver.js';
import { makeTempDir, rmrf, makeTar, pseudoRandomBuffer, sha256 } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'model-chunks.js');

function runTool(args, env = {}) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

/** Build a fake model + sandbox dirs shared by the tests. */
function setupSandbox(size = 3 * 1024 * 1024 + 12345) {
  const dir = makeTempDir('laya-chunks-');
  const model = path.join(dir, 'model.onnx');
  const manifestPath = path.join(dir, 'model.manifest.json');
  const outDir = path.join(dir, 'packages');
  fs.writeFileSync(model, pseudoRandomBuffer(size, 99));
  return {
    dir, model, manifestPath, outDir,
    env: { LAYA_CHUNKS_OUT_DIR: outDir, LAYA_CHUNKS_MANIFEST: manifestPath }
  };
}

/** The tool flattens scoped package names on disk: @scope/name -> @scope__name. */
const pkgDirFor = (outDir, pkgName) => path.join(outDir, pkgName.replace('/', '__'));

test('build: splits a model into chunk packages with per-chunk checksums', () => {
  const sb = setupSandbox();
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1', '--model-version', '1.0.0'], sb.env);

    const manifest = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    const stat = fs.statSync(sb.model);
    assert.equal(manifest.bytes, stat.size);
    assert.equal(manifest.sha256, sha256(fs.readFileSync(sb.model)));
    assert.equal(manifest.chunks.length, manifest.chunkCount);
    assert.ok(manifest.chunkCount >= 3, 'fake model must produce several chunks');

    let total = 0;
    for (const [i, c] of manifest.chunks.entries()) {
      const pkgDir = pkgDirFor(sb.outDir, c.package);
      assert.ok(fs.existsSync(path.join(pkgDir, 'package.json')), `chunk ${i} has a package.json`);
      assert.ok(fs.existsSync(path.join(pkgDir, 'chunk.bin')), `chunk ${i} has chunk.bin`);
      assert.equal(c.index, i);
      assert.equal(c.package, `@sys-one/laya-model-chunk-${String(i).padStart(2, '0')}`);
      assert.equal(c.bytes, fs.statSync(path.join(pkgDir, 'chunk.bin')).size);
      total += c.bytes;
    }
    assert.equal(total, stat.size, 'chunks must cover the whole model');

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDirFor(sb.outDir, manifest.chunks[0].package), 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.0.0');
    assert.equal(pkg.name, manifest.chunks[0].package);
    assert.deepEqual(pkg.scripts, {}, 'model data packages must never run install scripts');
  } finally {
    rmrf(sb.dir);
  }
});

test('build: chunk size is respected and the last chunk absorbs the remainder', () => {
  const sb = setupSandbox(2 * 1024 * 1024 + 17); // 2 MiB + 17 bytes
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const manifest = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    assert.equal(manifest.chunkCount, 3);
    assert.equal(manifest.chunks[0].bytes, 1024 * 1024);
    assert.equal(manifest.chunks[1].bytes, 1024 * 1024);
    assert.equal(manifest.chunks[2].bytes, 17);
  } finally {
    rmrf(sb.dir);
  }
});

test('assemble + verify: rebuilds a byte-identical model from the chunks', async () => {
  const sb = setupSandbox();
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const out = path.join(sb.dir, 'rebuilt.onnx');
    runTool(['assemble', '--out', out], sb.env);
    runTool(['verify', '--model', out], sb.env);

    assert.equal(await sha256File(out), JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8')).sha256);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(sb.model), 'reassembled model must be byte-identical');
  } finally {
    rmrf(sb.dir);
  }
});

test('verify: detects a tampered model', () => {
  const sb = setupSandbox(1024 * 600);
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const out = path.join(sb.dir, 'tampered.onnx');
    const data = fs.readFileSync(sb.model);
    data[10] ^= 0xff;
    fs.writeFileSync(out, data);

    assert.throws(
      () => runTool(['verify', '--model', out], sb.env),
      /sha256 mismatch|size mismatch/
    );
  } finally {
    rmrf(sb.dir);
  }
});

test('publish --dry-run: validates every chunk against the manifest', () => {
  const sb = setupSandbox(3 * 1024 * 1024); // 3 chunks at 1 MiB
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const out = runTool(['publish', '--dry-run'], sb.env);
    assert.match(out, /dry-run/);

    // corrupt one chunk -> publish must refuse
    const manifest = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    fs.writeFileSync(path.join(pkgDirFor(sb.outDir, manifest.chunks[1].package), 'chunk.bin'), 'nope');
    assert.throws(() => runTool(['publish', '--dry-run'], sb.env), /drifted from manifest/);
  } finally {
    rmrf(sb.dir);
  }
});

/* ------------------- registry (npm) acquisition path ------------------ */

/** Serve chunk packages as npm-style tarballs over HTTP. */
async function fakeRegistry(manifest, chunkBuffers) {
  const server = http.createServer((req, res) => {
    // scoped tarball URL: /@scope/name/-/name-version.tgz
    const m = /^\/((?:@[^/]+\/)?[^/]+)\/-\/[^/]+\.tgz$/.exec(req.url || '');
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    const pkgName = decodeURIComponent(m[1]);
    const idx = manifest.chunks.findIndex((c) => c.package === pkgName);
    if (idx < 0) { res.writeHead(404); res.end('no such package'); return; }

    const tar = makeTar([
      ['package/package.json', Buffer.from(JSON.stringify({ name: pkgName, version: manifest.chunks[idx].version }))],
      ['package/chunk.bin', chunkBuffers[idx]]
    ]);
    const tgz = zlib.gzipSync(tar);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': tgz.length });
    res.end(tgz);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, registry: `http://127.0.0.1:${server.address().port}` };
}

test('assembleFromRegistry: rebuilds the model from npm-style tarballs', async () => {
  const sb = setupSandbox(1024 * 900);
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const manifest = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    const buffers = manifest.chunks.map((c) => fs.readFileSync(path.join(pkgDirFor(sb.outDir, c.package), 'chunk.bin')));
    const { server, registry } = await fakeRegistry(manifest, buffers);

    try {
      const out = path.join(sb.dir, 'from-registry.onnx');
      const res = await assembleFromRegistry(manifest, out, true, registry);
      assert.equal(res.sha256, manifest.sha256);
      assert.deepEqual(fs.readFileSync(out), fs.readFileSync(sb.model));
    } finally {
      server.close();
    }
  } finally {
    rmrf(sb.dir);
  }
});

test('assembleFromRegistry: a corrupted chunk from the registry is rejected', async () => {
  const sb = setupSandbox(3 * 1024 * 1024); // 3 chunks at 1 MiB
  try {
    runTool(['build', '--model', sb.model, '--chunk-mb', '1'], sb.env);
    const manifest = JSON.parse(fs.readFileSync(sb.manifestPath, 'utf8'));
    const buffers = manifest.chunks.map((c) => fs.readFileSync(path.join(pkgDirFor(sb.outDir, c.package), 'chunk.bin')));
    buffers[1] = Buffer.from('this is not the model chunk you are looking for');
    const { server, registry } = await fakeRegistry(manifest, buffers);

    try {
      await assert.rejects(
        () => assembleFromRegistry(manifest, path.join(sb.dir, 'x.onnx'), true, registry),
        /checksum mismatch/
      );
    } finally {
      server.close();
    }
  } finally {
    rmrf(sb.dir);
  }
});

test('tarballUrl + extractTgz agree with what the registry serves', () => {
  const url = tarballUrl('@sys-one/laya-model-chunk-03', '2.0.0');
  assert.equal(url, 'https://registry.npmjs.org/@sys-one/laya-model-chunk-03/-/laya-model-chunk-03-2.0.0.tgz');

  const payload = Buffer.from('chunk-bytes');
  const tgz = zlib.gzipSync(makeTar([['package/chunk.bin', payload]]));
  assert.deepEqual(extractTgz(tgz).get('package/chunk.bin'), payload);
});
