import os from 'node:os';
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

// Dynamic runtime resolver:
// - Node.js AND Bun: onnxruntime-node (Native C++ CPU, ~25-80ms). Bun can
//   load the node binding fine, and it is ~20x faster than WASM (~1.7s).
//   NOTE: 'webgpu' is intentionally NOT used server-side — ORT's node
//   webgpu EP falls back per-op to CPU with huge overhead.
// - Browser only: onnxruntime-web (WASM SIMD + navigator.gpu WebGPU).
async function getOrt() {
  const isBrowser = typeof window !== 'undefined';

  if (!isBrowser) {
    try {
      const mod = await import('onnxruntime-node');
      return mod.default || mod;
    } catch (err) {
      // fallback to onnxruntime-web (e.g. exotic platform without binding)
    }
  }

  const mod = await import('onnxruntime-web');
  return mod.default || mod;
}

export class LayaEngine {
  constructor(session, config, ort) {
    this.session = session;
    this.config = config;
    this.ort = ort;
    // wasm-tract backend (optional): { pool } when backend === 'wasm'.
    this.wasmPool = null;
    this.backend = 'ort';
  }

  /** Use the pure-Rust wasm (tract) worker pool instead of onnxruntime. */
  async useWasmBackend(options = {}) {
    const { WasmPool } = await import('./laya-wasm-pool.js');
    const modelDir = options.modelDir || path.resolve(__dirname, '../models');
    const modelPath = await resolveModelPath(modelDir, options);
    this.wasmPool = new WasmPool({ modelPath, size: options.wasmWorkers });
    await this.wasmPool.ready();
    this.backend = 'wasm';
    return this;
  }

  static async load(options = {}) {
    const ort = await getOrt();
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
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        // fallback
      }
    }

    const device = options.device || 'auto';
    const isBrowser = typeof window !== 'undefined';
    let executionProviders;

    if (!isBrowser) {
      // Node.js AND Bun (both use onnxruntime-node): pure CPU is the
      // fastest path (~25-80ms). Never include 'webgpu' here — it triggers
      // per-op fallback overhead (~500ms+). 'wasm' is browser-only.
      // device 'wasm'/'webgpu' are accepted but ignored server-side.
      executionProviders = ['cpu'];
    } else if (device === 'webgpu') {
      executionProviders = ['webgpu', 'wasm'];
    } else if (device === 'wasm' || device === 'cpu') {
      executionProviders = ['wasm'];
    } else {
      // auto on Browser: prefer WebGPU, fall back to WASM SIMD
      executionProviders = ['webgpu', 'wasm'];
    }

    // Threading: measured on Snapdragon X (ARM64, Windows):
    //   Node: default pool (~12 threads) ≈ 25ms; intra1 ≈ 219ms.
    //   Bun: napi bridge serializes large-matmul thread sync badly —
    //   seqLen >= 64 degrades to ~1300ms with the default pool; small
    //   shapes stay fast. intraOpNumThreads: 1 keeps large shapes at
    //   ~90-110ms. So Bun pins 1 thread; Node keeps ORT defaults.
    //   Override with LAYA_THREADS / intraOpNumThreads if you know better.
    const isBunRt = typeof Bun !== 'undefined';
    const envThreads = parseInt(process.env.LAYA_THREADS || '', 10);
    const intraDefault = isBunRt ? 1 : 0; // 0 = leave unset (ORT default)
    const intraWanted = options.intraOpNumThreads || (Number.isFinite(envThreads) && envThreads > 0 ? envThreads : intraDefault);
    const sessionOptions = {
      executionProviders,
      graphOptimizationLevel: 'all',
      ...(intraWanted ? { intraOpNumThreads: intraWanted } : {}),
      ...(options.interOpNumThreads ? { interOpNumThreads: options.interOpNumThreads } : {}),
      enableCpuMemArena: true,
      enableMemPattern: true,
      executionMode: 'sequential',
      logSeverityLevel: 3
    };

    const session = await ort.InferenceSession.create(modelPath, sessionOptions);
    const engine = new LayaEngine(session, config, ort);

    // Warmup: first run includes graph partitioning + arena allocation and
    // is 3-10x slower. Run 2 tiny inferences now so real requests are fast.
    if (options.warmup !== false) {
      try {
        const warmIds = new Array(32).fill(10);
        const warmMarkers = [5, 12];
        await engine.runSingle({ ids: warmIds, markers: warmMarkers, qtype: 0 });
        await engine.runSingle({ ids: warmIds, markers: warmMarkers, qtype: 0 });
      } catch (e) {
        // Warmup is best-effort; ignore failures.
      }
    }
    return engine;
  }

  async runSingle(item) {
    // wasm-tract backend: dispatch to the worker pool (pure Rust, no ORT).
    if (this.backend === 'wasm' && this.wasmPool) {
      const { logits } = await this.wasmPool.infer(item);
      return logits;
    }
    const seqLen = item.ids.length;
    const numMarkers = item.markers.length;

    const inputIdsData = new BigInt64Array(seqLen);
    const attentionMaskData = new BigInt64Array(seqLen);
    const markerPosData = new BigInt64Array(numMarkers);
    const markerMaskData = new Uint8Array(numMarkers);
    const qtypeData = new BigInt64Array([BigInt(item.qtype)]);

    for (let c = 0; c < seqLen; c++) {
      inputIdsData[c] = BigInt(item.ids[c]);
      attentionMaskData[c] = 1n;
    }

    for (let m = 0; m < numMarkers; m++) {
      markerPosData[m] = BigInt(item.markers[m]);
      markerMaskData[m] = 1;
    }

    const feeds = {
      input_ids: new this.ort.Tensor('int64', inputIdsData, [1, seqLen]),
      attention_mask: new this.ort.Tensor('int64', attentionMaskData, [1, seqLen]),
      marker_pos: new this.ort.Tensor('int64', markerPosData, [1, numMarkers]),
      marker_mask: new this.ort.Tensor('bool', markerMaskData, [1, numMarkers]),
      qtype: new this.ort.Tensor('int64', qtypeData, [1])
    };

    const results = await this.session.run(feeds);
    return Array.from(results.logits.data);
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
    this._sessCache?.clear?.();
    if (this.session && typeof this.session.release === 'function') {
      try { await this.session.release(); } catch { /* best-effort */ }
    }
    this.session = null;
  }
}
