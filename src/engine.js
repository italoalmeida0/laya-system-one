import { envInt, isBrowser } from './env.js';

// Node builtins lazily: a static import makes this module unresolvable in a
// browser even when the browser path never touches the filesystem.
let _node = null;
async function nodeBuiltins() {
  if (!_node) {
    const [path, fs, url] = await Promise.all([
      import('node:path'), import('node:fs'), import('node:url')
    ]);
    _node = { path: path.default, fs: fs.default, url };
  }
  return _node;
}

/** The package's models/ directory: a path on Node, a URL in the browser. */
async function defaultModelDir() {
  if (isBrowser) return new URL('../models/', import.meta.url).href;
  const { path, url } = await nodeBuiltins();
  return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../models');
}

/** Read rl_agent_config.json, tolerating its absence (defaults apply). */
async function readConfig(modelDir) {
  const defaults = {
    max_len: 2048, head_max_len: 256,
    temperature: [1.0, 1.0, 1.0], temperature_by_options: {}
  };
  const base = String(modelDir).replace(/\/?$/, '/');
  try {
    if (isBrowser || /^https?:/.test(base)) {
      const res = await fetch(`${base}rl_agent_config.json`);
      if (!res.ok) return defaults;
      return { ...defaults, ...(await res.json()) };
    }
    const { path, fs } = await nodeBuiltins();
    const p = path.join(modelDir, 'rl_agent_config.json');
    if (!fs.existsSync(p)) return defaults;
    return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf-8')) };
  } catch {
    return defaults;
  }
}

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
  // The browser has no filesystem, no npm chunk packages and no cache
  // directory, so the Node resolver does not apply: the model is a URL.
  if (isBrowser) {
    if (options.modelPath) return options.modelPath;
    return new URL('model.onnx', String(modelDir).replace(/\/?$/, '/')).href;
  }
  const { resolveModel } = await import('./model-resolver.js');
  const resolved = await resolveModel({ modelDir, ...options });
  return resolved.path;
}

/**
 * Sequence-length buckets for the wasm backend.
 *
 * Powers of two up to a threshold, then coarser steps: a prompt lands in the
 * smallest bucket that fits, so the common short case runs short. The list is
 * bounded (10 shapes) because every distinct shape costs a full copy of the
 * weights in the wasm32 address space.
 *
 * LAYA_WASM_PAD overrides this with a single fixed size, for callers who
 * prefer one shape and predictable memory over speed.
 */
const SEQ_BUCKETS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

/** The smallest bucket that fits `len`, or the max_len ceiling. */
export function bucketFor(len, maxLen) {
  const forced = envInt('LAYA_WASM_PAD');
  if (forced && forced > 0) return len <= forced ? forced : maxLen;
  for (const b of SEQ_BUCKETS) {
    if (len <= b) return Math.min(b, maxLen);
  }
  return maxLen;
}

/** Marker-count buckets: a handful of questions per call, so 4/8/16/32. */
const MARKER_BUCKETS = [4, 8, 16, 32];
export function markerBucket(count) {
  for (const b of MARKER_BUCKETS) {
    if (count <= b) return b;
  }
  return 32;
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
    const modelDir = options.modelDir || await defaultModelDir();
    const modelPath = options.modelPath || await resolveModelPath(modelDir, options);
    this.wasmPool = new WasmPool({ modelPath, size: options.wasmWorkers, wasmBase: options.wasmBase });
    await this.wasmPool.ready();
    this.backend = 'wasm';
    return this;
  }

  static async load(options = {}) {
    const modelDir = options.modelDir || await defaultModelDir();
    const modelPath = options.modelPath || await resolveModelPath(modelDir, options);
    const config = await readConfig(modelDir);

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
    // tract specializes the model per concrete (S, M) and each plan holds its
    // own copy of the weights (~309 MB), so the number of distinct shapes has
    // to stay small: the wasm32 address space is 4 GB and the Rust side clears
    // its plan cache past 16 entries.
    //
    // A single large pad is safe but wasteful - a 43-token prompt padded to
    // 256 does 6x the work it needs to. Fixed buckets give most of that back
    // while keeping the shape count bounded: a prompt lands in the smallest
    // bucket that fits, so short inputs run short and long ones still work.
    // Padding is masked out (attention_mask 0, marker_mask false), so the
    // answer is identical to the unpadded one.
    const S = bucketFor(item.ids.length, this.config.max_len || 2048);
    const M = markerBucket(item.markers.length);

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
