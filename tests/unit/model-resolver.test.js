/**
 * Unit tests for the deterministic model acquisition pipeline
 * (src/model-resolver.js). Everything here is offline: chunk files and npm
 * tarballs are synthesized in a temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  sha256Buffer,
  sha256File,
  extractTar,
  extractTgz,
  tarballUrl,
  assembleChunks,
  findChunksOnDisk,
  resolveModel
} from '../../src/model-resolver.js';
import {
  makeTempDir,
  rmrf,
  makeTar,
  pseudoRandomBuffer,
  sha256
} from '../helpers/index.js';

const PAD = (n) => String(n).padStart(2, '0');

function writeChunks(dir, parts, names) {
  fs.mkdirSync(dir, { recursive: true });
  parts.forEach((p, i) => {
    fs.writeFileSync(path.join(dir, (names && names[i]) || `chunk-${PAD(i)}.bin`), p);
  });
}

function manifestFor(parts) {
  const buf = Buffer.concat(parts);
  return {
    model: 'model.onnx',
    bytes: buf.length,
    sha256: sha256(buf),
    chunkCount: parts.length,
    chunkBytes: Math.max(...parts.map((p) => p.length)),
    chunks: parts.map((p, i) => ({
      index: i,
      package: `laya-system-one-model-chunk-${PAD(i)}`,
      version: '1.0.0',
      bytes: p.length,
      sha256: sha256(p)
    }))
  };
}

/* ------------------------------ sha256 ------------------------------ */

test('sha256: file and buffer digests agree', async () => {
  const dir = makeTempDir();
  try {
    const data = pseudoRandomBuffer(1000, 7);
    const f = path.join(dir, 'x.bin');
    fs.writeFileSync(f, data);
    assert.equal(await sha256File(f), sha256Buffer(data));
  } finally {
    rmrf(dir);
  }
});

/* --------------------------- tar extraction -------------------------- */

test('extractTar: reads npm-style entries', () => {
  const a = Buffer.from('hello chunk zero');
  const b = Buffer.from('hello chunk one');
  const tar = makeTar([['package/chunk.bin', a], ['package/package.json', b]]);
  const entries = extractTar(tar);
  assert.deepEqual(entries.get('package/chunk.bin'), a);
  assert.deepEqual(entries.get('package/package.json'), b);
  assert.equal(entries.size, 2);
});

test('extractTar: handles entries larger than one block and padding', () => {
  const big = pseudoRandomBuffer(5000, 3); // spans multiple 512B blocks
  const tar = makeTar([['package/chunk.bin', big]]);
  const entries = extractTar(tar);
  assert.equal(entries.get('package/chunk.bin').length, 5000);
  assert.deepEqual(entries.get('package/chunk.bin'), big);
});

test('extractTar: stops cleanly at the end-of-archive marker', () => {
  const tar = makeTar([['package/a.bin', Buffer.from('a')]]);
  const entries = extractTar(tar);
  assert.equal(entries.size, 1);
  // trailing garbage after the terminator is ignored
  const withJunk = Buffer.concat([tar, Buffer.alloc(2048, 0xff)]);
  assert.equal(extractTar(withJunk).size, 1);
});

test('extractTgz: round-trips a gzipped npm tarball', () => {
  const payload = Buffer.from(JSON.stringify({ name: 'demo', version: '1.0.0' }));
  const tgz = zlib.gzipSync(makeTar([['package/package.json', payload]]));
  const entries = extractTgz(tgz);
  assert.deepEqual(JSON.parse(entries.get('package/package.json').toString()), { name: 'demo', version: '1.0.0' });
});

test('tarballUrl: builds the canonical registry URL', () => {
  assert.equal(
    tarballUrl('laya-system-one-model-chunk-00', '1.2.3'),
    'https://registry.npmjs.org/laya-system-one-model-chunk-00/-/laya-system-one-model-chunk-00-1.2.3.tgz'
  );
  assert.ok(tarballUrl('p', '1.0.0', 'https://registry.example/').endsWith('.tgz'));
});

/* ---------------------------- chunk assembly ------------------------- */

test('assembleChunks: concatenates in order and verifies the checksum', async () => {
  const dir = makeTempDir();
  try {
    const parts = [Buffer.from('AAA'), Buffer.from('BBB'), Buffer.from('CCC')];
    const manifest = manifestFor(parts);
    writeChunks(path.join(dir, 'chunks'), parts);

    const out = path.join(dir, 'out', 'model.onnx');
    const res = await assembleChunks(
      parts.map((_, i) => path.join(dir, 'chunks', `chunk-${PAD(i)}.bin`)),
      out,
      manifest
    );

    assert.equal(res.bytes, 9);
    assert.equal(res.sha256, manifest.sha256);
    assert.equal(fs.readFileSync(out, 'utf8'), 'AAABBBCCC');
  } finally {
    rmrf(dir);
  }
});

test('assembleChunks: rejects a corrupted chunk and leaves no partial file', async () => {
  const dir = makeTempDir();
  try {
    const parts = [Buffer.from('AAA'), Buffer.from('BBB')];
    const manifest = manifestFor(parts);
    const chunkDir = path.join(dir, 'chunks');
    writeChunks(chunkDir, parts);
    fs.writeFileSync(path.join(chunkDir, 'chunk-01.bin'), 'CORRUPTED!');

    const out = path.join(dir, 'model.onnx');
    await assert.rejects(
      () => assembleChunks([path.join(chunkDir, 'chunk-00.bin'), path.join(chunkDir, 'chunk-01.bin')], out, manifest),
      /checksum mismatch/
    );
    assert.equal(fs.existsSync(out), false, 'no model must be written on failure');
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, 'temp files cleaned up');
  } finally {
    rmrf(dir);
  }
});

test('assembleChunks: rejects a wrong chunk count', async () => {
  const dir = makeTempDir();
  try {
    const parts = [Buffer.from('A'), Buffer.from('B'), Buffer.from('C')];
    const manifest = manifestFor(parts);
    writeChunks(path.join(dir, 'c'), parts);
    await assert.rejects(
      () => assembleChunks([path.join(dir, 'c', 'chunk-00.bin')], path.join(dir, 'm.onnx'), manifest),
      /expected 3 chunks, got 1/
    );
  } finally {
    rmrf(dir);
  }
});

test('assembleChunks: works without a manifest (unverified mode)', async () => {
  const dir = makeTempDir();
  try {
    writeChunks(path.join(dir, 'c'), [Buffer.from('x'), Buffer.from('y')]);
    const res = await assembleChunks(
      [path.join(dir, 'c', 'chunk-00.bin'), path.join(dir, 'c', 'chunk-01.bin')],
      path.join(dir, 'm.onnx'),
      null
    );
    assert.equal(fs.readFileSync(res.path, 'utf8'), 'xy');
  } finally {
    rmrf(dir);
  }
});

/* --------------------------- chunk discovery ------------------------- */

test('findChunksOnDisk: plain chunk files', () => {
  const dir = makeTempDir();
  try {
    const parts = [Buffer.from('a'), Buffer.from('b')];
    writeChunks(dir, parts);
    const found = findChunksOnDisk(dir, manifestFor(parts));
    assert.equal(found.length, 2);
    assert.ok(found[0].endsWith('chunk-00.bin'));
    assert.ok(found[1].endsWith('chunk-01.bin'));
  } finally {
    rmrf(dir);
  }
});

test('findChunksOnDisk: installed npm chunk packages', () => {
  const dir = makeTempDir();
  try {
    const parts = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    const manifest = manifestFor(parts);
    parts.forEach((p, i) => {
      const pkg = path.join(dir, `laya-system-one-model-chunk-${PAD(i)}`);
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'chunk.bin'), p);
    });
    const found = findChunksOnDisk(dir, manifest);
    assert.equal(found.length, 3);
    assert.ok(found[0].endsWith(path.join('laya-system-one-model-chunk-00', 'chunk.bin')));
  } finally {
    rmrf(dir);
  }
});

test('findChunksOnDisk: missing directory returns an empty list', () => {
  assert.deepEqual(findChunksOnDisk('/definitely/not/here', null), []);
});

/* ----------------------------- resolveModel -------------------------- */

test('resolveModel: the modelPath option outranks everything else', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    const env = path.join(dir, 'env.onnx');
    const opt = path.join(dir, 'opt.onnx');
    fs.writeFileSync(env, 'ENV');
    fs.writeFileSync(opt, 'OPT');
    process.env.LAYA_MODEL_PATH = env;

    const res = await resolveModel({
      modelPath: opt,
      modelDir: path.join(dir, 'models'),
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      quiet: true
    });
    assert.equal(res.source, 'options');
    assert.equal(res.path, opt);

    await assert.rejects(
      () => resolveModel({ modelPath: path.join(dir, 'missing.onnx'), modelDir: path.join(dir, 'models'), allowNetwork: false, quiet: true }),
      /missing file/
    );
  } finally {
    if (prev === undefined) delete process.env.LAYA_MODEL_PATH; else process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});

test('resolveModel: LAYA_MODEL_PATH wins over everything', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    const model = path.join(dir, 'custom.onnx');
    fs.writeFileSync(model, 'MODEL');
    process.env.LAYA_MODEL_PATH = model;
    const res = await resolveModel({ modelDir: path.join(dir, 'empty'), cacheDir: path.join(dir, 'cache'), allowNetwork: false, quiet: true });
    assert.equal(res.source, 'env');
    assert.equal(res.path, model);
  } finally {
    if (prev === undefined) delete process.env.LAYA_MODEL_PATH; else process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});

test('resolveModel: LAYA_MODEL_PATH pointing at a directory works', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'MODEL');
    process.env.LAYA_MODEL_PATH = dir;
    const res = await resolveModel({ modelDir: path.join(dir, 'empty'), cacheDir: path.join(dir, 'cache'), allowNetwork: false, quiet: true });
    assert.equal(res.source, 'env');
    assert.ok(res.path.endsWith('model.onnx'));
  } finally {
    if (prev === undefined) delete process.env.LAYA_MODEL_PATH; else process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});

test('resolveModel: a model already in modelDir is used as-is', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    delete process.env.LAYA_MODEL_PATH;
    const modelDir = path.join(dir, 'models');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model.onnx'), 'LOCAL');
    const res = await resolveModel({ modelDir, cacheDir: path.join(dir, 'cache'), allowNetwork: false, quiet: true });
    assert.equal(res.source, 'local');
  } finally {
    if (prev !== undefined) process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});

test('resolveModel: assembles from LAYA_MODEL_CHUNKS_DIR', async () => {
  const dir = makeTempDir();
  const prev = { modelPath: process.env.LAYA_MODEL_PATH, chunksDir: process.env.LAYA_MODEL_CHUNKS_DIR };
  try {
    delete process.env.LAYA_MODEL_PATH;
    const parts = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
    const manifest = manifestFor(parts);
    const chunkDir = path.join(dir, 'chunks');
    writeChunks(chunkDir, parts);
    process.env.LAYA_MODEL_CHUNKS_DIR = chunkDir;

    const res = await resolveModel({
      modelDir: path.join(dir, 'models'),
      cacheDir: path.join(dir, 'cache'),
      manifest,
      allowNetwork: false,
      quiet: true
    });

    assert.equal(res.source, 'chunks-local');
    assert.equal(fs.readFileSync(res.path, 'utf8'), 'onetwothree');
  } finally {
    if (prev.modelPath === undefined) delete process.env.LAYA_MODEL_PATH; else process.env.LAYA_MODEL_PATH = prev.modelPath;
    if (prev.chunksDir === undefined) delete process.env.LAYA_MODEL_CHUNKS_DIR; else process.env.LAYA_MODEL_CHUNKS_DIR = prev.chunksDir;
    rmrf(dir);
  }
});

test('resolveModel: cached copy is reused and verified', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    delete process.env.LAYA_MODEL_PATH;
    const parts = [Buffer.from('cached-model')];
    const manifest = manifestFor(parts);
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'model.onnx'), Buffer.concat(parts));

    const res = await resolveModel({
      modelDir: path.join(dir, 'models'),
      cacheDir,
      manifest,
      allowNetwork: false,
      quiet: true
    });
    assert.equal(res.source, 'cache');
  } finally {
    if (prev !== undefined) process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});

test('resolveModel: corrupt cached copy is discarded and re-acquired', async () => {
  const dir = makeTempDir();
  const prev = { modelPath: process.env.LAYA_MODEL_PATH, chunksDir: process.env.LAYA_MODEL_CHUNKS_DIR };
  try {
    delete process.env.LAYA_MODEL_PATH;
    const parts = [Buffer.from('GOOD-MODEL')];
    const manifest = manifestFor(parts);
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'model.onnx'), 'BAD-MODEL');

    const chunkDir = path.join(dir, 'chunks');
    writeChunks(chunkDir, parts);
    process.env.LAYA_MODEL_CHUNKS_DIR = chunkDir;

    const res = await resolveModel({
      modelDir: path.join(dir, 'models'),
      cacheDir,
      manifest,
      allowNetwork: false,
      quiet: true
    });
    assert.equal(res.source, 'chunks-local', 'must rebuild from chunks, not trust the corrupt cache');
    assert.equal(fs.readFileSync(res.path, 'utf8'), 'GOOD-MODEL');
  } finally {
    if (prev.modelPath === undefined) delete process.env.LAYA_MODEL_PATH; else process.env.LAYA_MODEL_PATH = prev.modelPath;
    if (prev.chunksDir === undefined) delete process.env.LAYA_MODEL_CHUNKS_DIR; else process.env.LAYA_MODEL_CHUNKS_DIR = prev.chunksDir;
    rmrf(dir);
  }
});

test('resolveModel: offline with no model gives an actionable error', async () => {
  const dir = makeTempDir();
  const prev = process.env.LAYA_MODEL_PATH;
  try {
    delete process.env.LAYA_MODEL_PATH;
    await assert.rejects(
      () => resolveModel({ modelDir: path.join(dir, 'models'), cacheDir: path.join(dir, 'cache'), allowNetwork: false, quiet: true }),
      /LAYA_MODEL_PATH/
    );
  } finally {
    if (prev !== undefined) process.env.LAYA_MODEL_PATH = prev;
    rmrf(dir);
  }
});
