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
import { isBrowser, env } from './env.js';

// Node builtins are imported lazily, not at the top of the module: a static
// `import fs from 'node:fs'` fails to resolve in a browser even when the code
// path never touches the filesystem, which is what made this module
// unloadable there.
let _node = null;
async function nodeBuiltins() {
  if (!_node) {
    const [fs, path, url] = await Promise.all([
      import('node:fs'),
      import('node:path'),
      import('node:url')
    ]);
    _node = { fs: fs.default, path: path.default, url };
  }
  return _node;
}

let _mod = null;      // wasm-bindgen JS glue
let _wasmBytes = null;

/**
 * Where the wasm-pack output lives.
 *
 * Two things are resolved separately, because they load differently:
 *   - the .wasm BYTES are fetched (works over http in a browser, from disk on
 *     Node), so `wasmBase`/LAYA_WASM_BASE can point them at a CDN;
 *   - the glue MODULE is imported, and Node's ESM loader only accepts file:
 *     and data: URLs, so on Node it always comes from the package directory.
 */
async function wasmPkgUrls(options = {}) {
  const override = options.wasmBase || env('LAYA_WASM_BASE');
  const remoteBase = override ? new URL(String(override).replace(/\/?$/, '/'), import.meta.url) : null;

  if (isBrowser) {
    const base = remoteBase || new URL('./wasm-pkg/', import.meta.url);
    return {
      glue: new URL('laya_inference.js', base).href,
      wasm: new URL('laya_inference_bg.wasm', base).href
    };
  }

  const { path, url } = await nodeBuiltins();
  const pkgDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'wasm-pkg');
  return {
    // Node cannot import over http:, so the glue is always local here
    glue: url.pathToFileURL(path.join(pkgDir, 'laya_inference.js')).href,
    wasm: remoteBase
      ? new URL('laya_inference_bg.wasm', remoteBase).href
      : url.pathToFileURL(path.join(pkgDir, 'laya_inference_bg.wasm')).href
  };
}

async function getModule(options = {}) {
  if (_mod) return _mod;
  const urls = await wasmPkgUrls(options);

  if (!_wasmBytes) {
    if (isBrowser) {
      const res = await fetch(urls.wasm);
      if (!res.ok) throw new Error(`could not fetch the wasm engine: ${res.status} ${urls.wasm}`);
      _wasmBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      const { fs } = await nodeBuiltins();
      _wasmBytes = fs.readFileSync(new URL(urls.wasm));
    }
  }

  // The wasm-pack `--target web` glue imports its sibling relatively, so it
  // resolves the same way from a file URL or a browser URL.
  const glue = await import(/* @vite-ignore */ urls.glue);
  // `initSync` compiles the module on the calling thread, and Chrome refuses
  // to compile more than 8 MB that way ("Compile is disallowed on the main
  // thread"). This wasm is ~13 MB, so the browser must take the async path,
  // which uses WebAssembly.compile. Node has no such limit, but the async call
  // works there too, so one path serves both.
  await glue.default({ module_or_path: _wasmBytes });
  _mod = glue;
  return glue;
}

/**
 * Load a model. `source`: path to model.onnx or Uint8Array of its bytes.
 * Returns { infer(ids, attn, markers, markerMask, qtype) -> Float32Array, cacheSize(), free() }.
 */
export async function loadWasmModel(source, options = {}) {
  const glue = await getModule(options);
  let bytes;
  if (typeof source === 'string') {
    // A path on Node, a URL in the browser.
    if (isBrowser) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`could not fetch the model: ${res.status} ${source}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      const { fs } = await nodeBuiltins();
      bytes = fs.readFileSync(source);
    }
  } else if (source instanceof Uint8Array) {
    bytes = source;
  } else {
    throw new Error('loadWasmModel: source must be a path or Uint8Array');
  }
  const inner = glue.LayaWasm.load(bytes);
  return {
    infer(inputIds, attentionMask, markerPos, markerMask, qtype) {
      const ids = BigInt64Array.from(inputIds.map((v) => BigInt(v)));
      const am = BigInt64Array.from(attentionMask.map((v) => BigInt(v)));
      const mp = BigInt64Array.from(markerPos.map((v) => BigInt(v)));
      // wasm-bindgen takes &[bool] as a Uint8Array of 0/1
      const mm = Uint8Array.from(markerMask.map((v) => (v ? 1 : 0)));
      return inner.infer(ids, am, mp, mm, BigInt(qtype));
    },
    cacheSize() { return inner.cache_size(); },
    free() { inner.free(); },
  };
}

/** For diagnostics: raw glue (LayaWasm class). */
export async function wasmGlue() {
  return getModule();
}
