import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { resolveModel } from './model-resolver.js';

/**
 * Resolve `model.onnx` to a local path, acquiring it if needed.
 *
 * Thin compat wrapper over model-resolver.js — layered and deterministic:
 *   LAYA_MODEL_PATH -> local file -> verified cache -> npm chunk packages
 *   -> GitHub Releases asset. Every copy is sha256-verified and written
 *   atomically, so an interrupted download never leaves a corrupt model.
 *
 * @returns {Promise<string>} absolute path to model.onnx
 */
export async function resolveModelPath(modelDir, options = {}) {
  const resolved = await resolveModel({ modelDir, ...options });
  return resolved.path;
}

// JS-side inference runs on the bundled pure-Rust wasm (tract) engine.
// The fast path is the bundled native binary (LayaNative) which does its
// own inference in Rust. No onnxruntime / external runtime is used.

export class LayaEngine {
  constructor(session, config) {
    this.session = session;
    this.config = config;
    // wasm-tract backend: { pool } (the only JS-side backend; the native
    // binary path is LayaNative, not LayaEngine).
    this.wasmPool = null;
    this.backend = 'wasm';
  }

  /** Use the pure-Rust wasm (tract) worker pool (no ORT anywhere). */
  async useWasmBackend(options = {}) {
    const { WasmPool } = await import('./laya-wasm-pool.js');
    const modelDir = options.modelDir || path.resolve(__dirname, '../models');
    const modelPath = options.modelPath || await resolveModelPath(modelDir, options);
    this.wasmPool = new WasmPool({ modelPath, size: options.wasmWorkers });
    await this.wasmPool.ready();
    this.backend = 'wasm';
    return this;
  }

  static async load(options = {}) {
    const modelDir = options.modelDir || path.resolve(__dirname, '../models');
    const modelPath = await resolveModelPath(modelDir, options);
    const configPath = path.join(modelDir, 'rl_agent_config.json');

    let config = {
      max_len: 1024,
      head_max_len: 256,
      temperature: [1.0, 1.0, 1.0],
      temperature_by_options: {}
    };
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* defaults */ }
    }

    const engine = new LayaEngine(null, config);
    await engine.useWasmBackend({ ...options, modelDir, modelPath });
    return engine;
  }

  async runSingle(item) {
    if (this.backend === 'wasm' && this.wasmPool) {
      const padded = this.padForWasm(item);
      const { logits } = await this.wasmPool.infer({ ...padded, qtype: item.qtype });
      // the padded shape emits extra logits; only the real markers matter
      return Array.from(logits).slice(0, item.markers.length);
    }
    throw new Error('LayaEngine: no inference backend loaded (use backend "native" or "wasm")');
  }

  /**
   * Pad one item to the single fixed (S, M) shape the wasm engine runs.
   *
   * tract must specialize the whole model per concrete input shape, and
   * every specialized plan keeps its own copy of the ~309 MB of weights.
   * Growing one plan per input length exhausts the wasm32 address space
   * (4 GB) after a handful of shapes and traps with "unreachable". So the
   * wasm path always runs one shape and masks the padding out
   * (attention_mask = 0, marker_mask = false), which makes the padded
   * answer identical to the unpadded one.
   */
  padForWasm(item) {
    // Shape budget: tract specializes the model per concrete (S, M) and each
    // plan holds its own copy of the weights, so only a couple of shapes may
    // ever exist. Short sequences use the small bucket, long ones the full
    // max_len bucket (slow but rare). Both mask the padding out, so the
    // answer is identical to the unpadded one.
    // read per call so LAYA_WASM_PAD can be tuned without a restart
    const padLen = Number.parseInt(process.env.LAYA_WASM_PAD || '', 10) || 256;
    const S = item.ids.length <= padLen ? padLen : (this.config.max_len || 1024);
    const M = 32;
    if (item.ids.length > S) {
      throw new Error(`wasm backend: sequence of ${item.ids.length} tokens exceeds the fixed shape ${S}`);
    }
    if (item.markers.length > M) {
      throw new Error(`wasm backend: ${item.markers.length} markers exceed the fixed shape ${M}`);
    }
    const ids = item.ids.slice();
    const attn = new Array(S).fill(0);
    for (let i = 0; i < item.ids.length; i++) attn[i] = 1;
    while (ids.length < S) ids.push(0); // <pad>

    const markers = item.markers.slice();
    const markerMask = new Array(M).fill(false);
    for (let i = 0; i < item.markers.length; i++) markerMask[i] = true;
    while (markers.length < M) markers.push(0);

    return { ids, attn, markers, markerMask };
  }

  async run(batch) {
    const allLogits = [];
    for (const item of batch) {
      const logits = await this.runSingle(item);
      allLogits.push(logits);
    }
    return allLogits;
  }

  /**
   * Release native/wasm resources. Safe to call multiple times.
   * Keeps shutdown deterministic (no leaked sessions or worker threads
   * keeping the process alive).
   */
  async close() {
    const pool = this.wasmPool || this.wasm;
    if (pool && typeof pool.close === 'function') {
      try { await pool.close(); } catch { /* best-effort */ }
    }
    this.wasmPool = null;
    this.wasm = null;
    this.session = null;
  }
}
