/**
 * Model-distribution integration test (requires models/model.onnx).
 *
 * Proves the flagship feature end to end: the 324 MB INT8 model survives
 * the split -> chunk packages -> reassemble pipeline byte-for-byte AND the
 * reassembled checkpoint actually loads and predicts.
 *
 * This is slow (it hashes and rewrites the whole model): skip locally with
 * LAYA_SKIP_MODEL_DIST=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256File, assembleChunks, findChunksOnDisk, readManifest } from '../../src/model-resolver.js';
import { Laya } from '../../src/agent.js';
import { makeTempDir, rmrf, NATIVE_SKIP } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL = path.join(ROOT, 'models', 'model.onnx');
const CHUNKS_DIR = path.join(ROOT, 'dist', 'model-chunks');
const TOOL = path.join(ROOT, 'tools', 'model-chunks.js');

const HAS_MODEL = fs.existsSync(MODEL);
const skip = HAS_MODEL
  ? (process.env.LAYA_SKIP_MODEL_DIST === '1' ? 'LAYA_SKIP_MODEL_DIST=1' : false)
  : 'models/model.onnx not present';

function runTool(args) {
  return execFileSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
}

function ensureChunks() {
  const manifestPath = path.join(CHUNKS_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) return;
  runTool(['build', '--chunk-mb', '24', '--model-version', '1.0.0']);
}

test('real model is split into chunk packages and reassembled byte-identically', { skip, timeout: 900000 }, async () => {
  ensureChunks();

  const manifest = readManifest(path.join(ROOT, 'models'));
  assert.ok(manifest, 'models/model.manifest.json must exist');
  assert.equal(manifest.bytes, fs.statSync(MODEL).size);
  assert.equal(manifest.chunks.length, manifest.chunkCount);
  assert.ok(manifest.chunkCount >= 2, 'the real model must span several chunks');

  // every chunk package must be a valid, self-describing npm package
  for (const c of manifest.chunks) {
    const pkgDir = path.join(CHUNKS_DIR, c.package);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, c.package);
    assert.equal(pkg.version, c.version);
    assert.deepEqual(pkg.scripts, {}, `${c.package} must never run install scripts`);
    assert.ok(fs.existsSync(path.join(pkgDir, 'chunk.bin')));
  }

  const chunks = findChunksOnDisk(CHUNKS_DIR, manifest);
  assert.equal(chunks.length, manifest.chunkCount);

  const tmp = makeTempDir('laya-dist-');
  try {
    // laya-serve resolves everything from --model-dir, so the reassembled
    // model must sit next to the tokenizer/config files.
    const modelDir = path.join(tmp, 'models');
    await fs.promises.mkdir(modelDir, { recursive: true });
    const out = path.join(modelDir, 'model.onnx');
    await assembleChunks(chunks, out, manifest);

    const sha = await sha256File(out);
    assert.equal(sha, manifest.sha256, 'reassembled model must match the manifest');
    assert.equal(sha, await sha256File(MODEL), 'reassembled model must match the original');

    for (const f of ['tokenizer.json', 'tokenizer_config.json', 'rl_agent_config.json']) {
      await fs.promises.copyFile(path.join(ROOT, 'models', f), path.join(modelDir, f));
    }

    // ...and it must be functional, not just byte-identical. ort runs
    // everywhere; the native binary is exercised too when it is built.
    for (const backend of NATIVE_SKIP ? ['wasm'] : ['wasm', 'native']) {
      const laya = await Laya.load({ modelDir, backend });
      try {
        const res = await laya.predict('I was charged twice on my invoice and need a refund.', {
          department: {
            type: 'choice',
            instructions: 'Which department?',
            criteria: { billing: 'refunds', tech: 'bugs' }
          }
        });
        assert.equal(res.answers.department.choice, 'billing', `reassembled model misbehaves on backend=${backend}`);
      } finally {
        await laya.close();
      }
    }
  } finally {
    rmrf(tmp);
  }
});

test('chunk packages are small enough for the npm registry payload limit', { skip, timeout: 900000 }, () => {
  ensureChunks();
  const manifest = readManifest(path.join(ROOT, 'models'));
  const MAX = 200 * 1024 * 1024; // registry rejects payloads above ~200 MB
  for (const c of manifest.chunks) {
    assert.ok(c.bytes < MAX, `${c.package} is ${c.bytes} bytes — too large for npm`);
    // leave headroom for tar/gzip overhead and registry variance
    assert.ok(c.bytes <= 64 * 1024 * 1024, `${c.package} should stay at or below 64 MB`);
  }
});

test('the shipped manifest is the single source of truth for checksums', { skip, timeout: 900000 }, async () => {
  const manifest = readManifest(path.join(ROOT, 'models'));
  assert.equal(manifest.model, 'model.onnx');
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.sources?.github, 'the GitHub fallback must stay documented in the manifest');
  assert.equal(await sha256File(MODEL), manifest.sha256);
});
