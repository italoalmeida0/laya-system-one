/**
 * laya-wasm.js — universal pure-Rust inference backend (tract → wasm).
 *
 * ONE binary (`wasm-pkg/laya_inference_bg.wasm`, ~9MB) runs identically on:
 * Node.js, Bun, browsers, WSL2 — no onnxruntime, no per-OS native libs,
 * no thread-pool roulette. Single-threaded wasm = deterministic latency
 * on every runtime.
 *
 * Usage:
 *   import { loadWasmModel } from './laya-wasm.js';
 *   const m = await loadWasmModel('/path/to/model.onnx'); // or Uint8Array
 *   const logits = m.infer([10,10,...], [5,12,19], 0);    // Float32Array
 *
 * Notes:
 * - `load` parses + optimizes the 309MB ONNX (seconds, once). The model
 *   is specialized per (S, M) shape on first use (cached in Rust).
 * - No threads: wasm32-unknown has no threads. Throughput comes from
 *   SIMD (wasm-opt -O3) + zero native-bridge overhead. For parallel
 *   requests, run N workers (see README) — each with its own instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _mod = null;      // wasm-bindgen JS glue
let _wasmBytes = null;

async function getModule() {
  if (_mod) return _mod;
  const pkgDir = path.join(__dirname, 'wasm-pkg');
  if (!_wasmBytes) {
    _wasmBytes = fs.readFileSync(path.join(pkgDir, 'laya_inference_bg.wasm'));
  }
  // The wasm-pack `--target web` glue imports from './laya_inference_bg.js'
  // relatively — import it via file URL so it resolves on Node/Bun.
  const glueUrl = pathToFileURL(path.join(pkgDir, 'laya_inference.js')).href;
  const glue = await import(glueUrl);
  // `initSync` takes the raw bytes (no fetch needed server-side).
  glue.initSync({ module: _wasmBytes });
  _mod = glue;
  return glue;
}

/**
 * Load a model. `source`: path to model.onnx or Uint8Array of its bytes.
 * Returns { infer(ids, markers, qtype) -> Float32Array, cacheSize(), free() }.
 */
export async function loadWasmModel(source) {
  const glue = await getModule();
  let bytes;
  if (typeof source === 'string') {
    bytes = fs.readFileSync(source);
  } else if (source instanceof Uint8Array) {
    bytes = source;
  } else {
    throw new Error('loadWasmModel: source must be a path or Uint8Array');
  }
  const inner = glue.LayaWasm.load(bytes);
  return {
    infer(inputIds, markerPos, qtype) {
      const ids = BigInt64Array.from(inputIds.map((v) => BigInt(v)));
      const mp = BigInt64Array.from(markerPos.map((v) => BigInt(v)));
      return inner.infer(ids, mp, BigInt(qtype));
    },
    cacheSize() { return inner.cache_size(); },
    free() { inner.free(); },
  };
}

/** For diagnostics: raw glue (LayaWasm class). */
export async function wasmGlue() {
  return getModule();
}
