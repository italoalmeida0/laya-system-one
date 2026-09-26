/**
 * laya-wasm-worker.js — dedicated worker for pure-Rust wasm inference.
 *
 * Each worker owns ONE LayaWasm instance (its own tract runnables).
 * Protocol (parent <-> worker via postMessage):
 *   parent -> { type: 'load', modelPath }            => { type: 'loaded', ms }
 *   parent -> { type: 'infer', id, ids, markers, q } => { type: 'result', id, logits, ms }
 *                                                      | { type: 'error', id, message }
 *
 * Works in Node.js (worker_threads) and Bun (Worker). The model bytes are
 * read inside the worker so the 309MB buffer is never cloned/copied.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadWasmModel } from './laya-wasm.js';

let model = null;

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      model = await loadWasmModel(msg.modelPath || workerData?.modelPath);
      // Warmup is done per-shape on first infer; just report load time.
      parentPort.postMessage({ type: 'loaded', ms: performance.now() - t0 });
    } else if (msg.type === 'infer') {
      if (!model) throw new Error('model not loaded');
      const t0 = performance.now();
      const logits = model.infer(msg.ids, msg.markers, msg.q);
      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        logits: Array.from(logits),
        ms: performance.now() - t0,
      });
    }
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      id: msg?.id ?? null,
      message: String(err?.message || err),
    });
  }
});
