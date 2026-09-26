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
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class WasmPool {
  constructor(options = {}) {
    this.modelPath = options.modelPath || path.join(__dirname, '../models/model.onnx');
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
    const workerPath = path.join(__dirname, 'laya-wasm-worker.js');
    const loads = [];
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
  async infer({ ids, markers, qtype }) {
    await this.ready();
    const w = await this._acquire();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: w });
      w.busy = true;
      w.postMessage({ type: 'infer', id, ids, markers, q: qtype });
    });
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
  const env = parseInt(process.env.LAYA_WASM_WORKERS || '', 10);
  if (Number.isFinite(env) && env > 0) return Math.min(env, 8);
  return 1;
}
