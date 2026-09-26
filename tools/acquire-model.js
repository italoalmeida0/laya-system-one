#!/usr/bin/env node
/**
 * acquire-model.js — make sure `models/model.onnx` exists, downloading or
 * reassembling it if needed. Useful in CI, Docker builds and air-gapped
 * setups that want the model present *before* the first prediction.
 *
 *   node tools/acquire-model.js [--quiet] [--offline] [--github]
 *
 * --offline  never touch the network (fails if the model cannot be resolved
 *            from local chunks/copy).
 * --github   allow the GitHub Release download. Needed in CI, where the
 *            @sys-one model chunk packages are not published yet: the
 *            release asset is the only copy of the model available.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel, sha256File, readManifest } from '../src/model-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '..', 'models');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const allowNetwork = !args.includes('--offline');
if (args.includes('--github')) process.env.LAYA_ALLOW_GITHUB_FALLBACK = '1';

try {
  const started = Date.now();
  const res = await resolveModel({ modelDir: MODELS_DIR, quiet, allowNetwork });
  const manifest = readManifest(MODELS_DIR);

  if (!quiet) {
    console.log(`[acquire] source : ${res.source}`);
    console.log(`[acquire] path   : ${res.path}`);
    if (manifest?.sha256) {
      console.log(`[acquire] sha256 : expected ${manifest.sha256}`);
      const actual = await sha256File(res.path);
      if (actual !== manifest.sha256) {
        console.error(`[acquire] MISMATCH: ${actual}`);
        process.exit(1);
      }
      console.log(`[acquire] sha256 : verified ✔`);
    }
    console.log(`[acquire] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} catch (err) {
  console.error(`[acquire] FAILED: ${err?.message || err}`);
  process.exit(1);
}
