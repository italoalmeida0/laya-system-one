/**
 * laya-native.js — JS wrapper for the self-contained `laya-serve` binary.
 *
 * Architecture (2 cases, no roulette):
 *   - Native (Node/Bun/WSL, any OS): spawn the `laya-serve` binary
 *     (Axum + tokenizers + ONNX Runtime, statically linked) and proxy
 *     `/v1/systemone` over localhost HTTP. JS never touches IA.
 *   - Browser: use the wasm backend (`backend: 'wasm'`).
 *
 * Binary resolution order:
 *   1. LAYA_SERVE_BIN env var (explicit path)
 *   2. dist/bin/<platform>-<arch>/laya-serve[.exe] next to this package (bin/ legacy fallback)
 *      (platform: linux|win32|darwin, arch: x64|arm64, musl variant ok)
 *   3. `laya-serve` on PATH
 *
 * Usage:
 *   import { NativeServer } from './laya-native.js';
 *   const srv = new NativeServer({ modelDir: 'models', port: 0 });
 *   await srv.start();            // spawns binary, waits LAYA_READY
 *   const out = await srv.predict(state, questions);
 *   await srv.stop();
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveBinary() {
  if (process.env.LAYA_SERVE_BIN) return process.env.LAYA_SERVE_BIN;
  const plat = os.platform(); // linux | win32 | darwin
  // NOTE: Bun on Windows-ARM64 reports x64 (emulation string); the real
  // arch may be arm64. Probe candidate dirs and pick the first that exists.
  // linux-*-musl is preferred on musl systems (Alpine/Docker): the
  // binary itself is musl, and the ORT runtime ships BUNDLED in
  // dist/bin/<plat>-<arch>-musl/lib/ (musl-native .so set extracted from the
  // Alpine apk: libonnxruntime + protobuf/re2/abseil/libstdc++ — the PyPI
  // .so is glibc-linked and can never load on musl). resolveBinary()
  // injects the lib dir into the child process LD_LIBRARY_PATH so the
  // binary finds its own bundled libs with zero system deps beyond musl.
  const arches = os.arch() === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64'];
  const exe = plat === 'win32' ? 'laya-serve.exe' : 'laya-serve';
  const candidates = [];
  for (const arch of arches) {
    if (plat === 'linux') candidates.push(`linux-${arch}-musl`);
    candidates.push(`${plat}-${arch}`);
  }
  for (const dir of candidates) {
    const base = path.join(__dirname, '..', 'dist', 'bin', dir);
    const legacy = path.join(__dirname, '..', 'bin', dir);
    // musl: prefer the self-extracting bundle (ONE file, libs inside).
    if (dir.endsWith('-musl')) {
      const bundle = path.join(base, 'laya-serve.bundle');
      if (fs.existsSync(bundle)) return bundle;
      const legacyBundle = path.join(legacy, 'laya-serve.bundle');
      if (fs.existsSync(legacyBundle)) return legacyBundle;
    }
    const local = path.join(base, exe);
    if (fs.existsSync(local)) return local;
    const legacyLocal = path.join(legacy, exe);
    if (fs.existsSync(legacyLocal)) return legacyLocal;
  }
  return 'laya-serve'; // PATH fallback
}

export class NativeServer {
  constructor(options = {}) {
    this.modelDir = options.modelDir || path.join(__dirname, '..', 'models');
    this.host = options.host || '127.0.0.1';
    this.port = options.port ?? 0;
    this.apiKey = options.apiKey || null;
    this.threads = options.threads ?? 0;
    this.proc = null;
    this.url = null;
  }

  async start() {
    if (this.proc) return this;
    const bin = resolveBinary();
    // Make sure model.onnx is present before spawning (downloads or
    // reassembles it from npm chunk packages on first use, checksum-verified).
    const { resolveModelPath } = await import('./engine.js');
    const modelPath = await resolveModelPath(this.modelDir);
    const modelDir = path.dirname(modelPath);
    // Bundled musl libs: dist/bin/<plat>-<arch>-musl/lib/ must be visible to
    // the child loader. Merge into spawn env (not process.env) so the
    // parent runtime is untouched.
    const spawnEnv = { ...process.env };
    const binDir = path.dirname(bin);
    const bundledLib = path.join(binDir, 'lib');
    if (path.basename(binDir).endsWith('-musl') && fs.existsSync(bundledLib)) {
      spawnEnv.LD_LIBRARY_PATH = spawnEnv.LD_LIBRARY_PATH
        ? bundledLib + ':' + spawnEnv.LD_LIBRARY_PATH
        : bundledLib;
    }
    const args = [
      '--model-dir', modelDir,
      '--host', this.host,
      '--port', String(this.port),
      '--threads', String(this.threads),
    ];
    if (this.apiKey) args.push('--api-key', this.apiKey);
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
      this.proc = proc;
      let out = '';
      const timer = setTimeout(() => {
        reject(new Error(`laya-serve did not become ready in 120s (bin: ${bin})`));
        try { proc.kill(); } catch { /* ignore */ }
      }, 120000);
      proc.stdout.on('data', (d) => {
        out += d.toString();
        const m = out.match(/LAYA_READY\s+(\S+)/);
        if (m) {
          clearTimeout(timer);
          const addr = m[1];
          const port = addr.split(':').pop();
          this.url = `http://${this.host}:${port}`;
          resolve(this);
        }
      });
      proc.stderr.on('data', () => { /* logs; ignore unless debugging */ });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn laya-serve (${bin}): ${err.message}`));
      });
      proc.on('exit', (code) => {
        if (!this.url) {
          clearTimeout(timer);
          reject(new Error(`laya-serve exited before ready (code ${code}, bin: ${bin})`));
        }
      });
    });
  }

  async predict(state, questions, model) {
    if (!this.url) throw new Error('NativeServer not started');
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const r = await fetch(`${this.url}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model || 'laya-multilingual', state, questions }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`laya-serve ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }

  async health() {
    const r = await fetch(`${this.url}/health`);
    return r.json();
  }

  async stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
      this.url = null;
    }
  }
}
