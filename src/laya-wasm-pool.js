/**
 * laya-wasm-pool.js — pool of dedicated wasm inference workers.
 *
 * - Each worker = 1 thread + 1 LayaWasm instance (own tract runnables).
 * - Requests are dispatched round-robin; each worker processes one
 *   inference at a time (tract SimplePlan is not thread-safe-shared).
 * - Same API shape as LayaEngine.runSingle: infer({ids, markers, qtype}).
 *
 *   import { WasmPool } from './laya-wasm-pool.js';
 *   const pool = new WasmPool({ modelPath: 'models/model.onnx', size: 4 });
 *   await pool.ready();
 *   const logits = await pool.infer({ ids, markers, qtype: 0 });
 *   await pool.close();
 */
import { isBrowser, envInt } from './env.js';

// Node builtins lazily: node:worker_threads does not exist in a browser, and
// importing it at module scope makes this file unresolvable there. In the
// browser the pool runs the engine inline (one instance, no workers) - the
// wasm module is single-threaded anyway, so a pool would only add copies of
// the 309 MB of weights.
let _node = null;
async function nodeBuiltins() {
  if (!_node) {
    const [wt, os, path, url] = await Promise.all([
      import('node:worker_threads'), import('node:os'),
      import('node:path'), import('node:url')
    ]);
    _node = { Worker: wt.Worker, os: os.default, path: path.default, url };
  }
  return _node;
}

async function defaultModelPath() {
  if (isBrowser) return new URL('../models/model.onnx', import.meta.url).href;
  const { path, url } = await nodeBuiltins();
  return path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../models/model.onnx');
}

export class WasmPool {
  constructor(options = {}) {
    this.modelPath = options.modelPath || null; // resolved in ready()
    this.wasmBase = options.wasmBase || null;
    this.size = Math.max(1, options.size || defaultPoolSize());
    this.workers = [];
    this.pending = new Map(); // id -> { resolve, reject }
    this.nextId = 1;
    this.rr = 0;
    this._ready = null;
  }

  static defaultSize() {
    return defaultPoolSize();
  }

  ready() {
    if (!this._ready) this._ready = this._spawn();
    return this._ready;
  }

  async _spawn() {
    if (!this.modelPath) this.modelPath = await defaultModelPath();

    // Browser: no worker_threads. Load one engine inline and answer directly.
    if (isBrowser) {
      const { loadWasmModel } = await import('./laya-wasm.js');
      this.inline = await loadWasmModel(this.modelPath, { wasmBase: this.wasmBase });
      return this;
    }

    const { path } = await nodeBuiltins();
    const workerPath = path.join(path.dirname((await nodeBuiltins()).url.fileURLToPath(import.meta.url)), 'laya-wasm-worker.js');
    const loads = [];
    const { Worker } = await nodeBuiltins();
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerPath);
      w.busy = false;
      w.on('message', (msg) => this._onMessage(w, msg));
      w.on('error', (err) => {
        // Fail all pending routed to this worker.
        for (const [id, p] of this.pending) {
          if (p.worker === w) {
            this.pending.delete(id);
            p.reject(err);
          }
        }
      });
      this.workers.push(w);
      loads.push(
        new Promise((resolve, reject) => {
          w._loadResolve = resolve;
          w._loadReject = reject;
          w.postMessage({ type: 'load', modelPath: this.modelPath });
        })
      );
    }
    await Promise.all(loads);
    return this;
  }

  _onMessage(w, msg) {
    if (msg.type === 'loaded') {
      w._loadResolve?.();
      w._loadResolve = null;
      return;
    }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.worker.busy = false;
        p.resolve({ logits: msg.logits, ms: msg.ms });
      }
      return;
    }
    if (msg.type === 'error') {
      if (msg.id == null) {
        w._loadReject?.(new Error(msg.message));
        w._loadReject = null;
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.worker.busy = false;
        p.reject(new Error(msg.message));
      }
    }
  }

  /** Run one inference on the next free worker (waits if all busy). */
  async infer({ ids, attn, markers, markerMask, qtype }) {
    await this.ready();

    // Browser: one inline engine, called directly. tract's plan is not
    // reentrant, so calls are serialized through a promise chain.
    if (this.inline) {
      const run = async () => {
        const logits = this.inline.infer(ids, attn, markers, markerMask, qtype);
        return { logits };
      };
      this._chain = (this._chain || Promise.resolve()).then(run, run);
      return this._chain;
    }

    const w = await this._acquire();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, worker: w });
      w.postMessage({ type: 'infer', id, ids, attn, markers, markerMask, q: qtype });
    }).finally(() => { w.busy = false; });
  }

  async _acquire() {
    for (;;) {
      for (let i = 0; i < this.workers.length; i++) {
        this.rr = (this.rr + 1) % this.workers.length;
        if (!this.workers[this.rr].busy) return this.workers[this.rr];
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  async close() {
    for (const w of this.workers) {
      try { await w.terminate(); } catch { /* ignore */ }
    }
    this.workers = [];
    this._ready = null;
  }
}

function defaultPoolSize() {
  // Each worker keeps its own copy of the ~309 MB weights in wasm memory, so
  // the pool size multiplies the footprint. The wasm engine is the
  // portability fallback (the fast path is the native binary), so one worker
  // is the sane default; raise it with LAYA_WASM_WORKERS for throughput.
  //
  // A browser has no workers here (it runs the engine inline) and no
  // environment, so this must not touch either.
  if (isBrowser) return 1;
  const env = envInt('LAYA_WASM_WORKERS');
  if (env && env > 0) return Math.min(env, 8);
  return 1;
}
