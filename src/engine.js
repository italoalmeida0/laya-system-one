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
      const { logits } = await this.wasmPool.infer(item);
      return logits;
    }
    throw new Error('LayaEngine: no inference backend loaded (use backend "native" or "wasm")');
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
