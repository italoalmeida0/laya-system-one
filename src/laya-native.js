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

/**
 * True when the process runs on musl (Alpine, some containers).
 * A glibc-linked binary can never load there, so it must never be picked.
 */
export function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report?.getReport?.();
    if (report && report.header && 'glibcVersionRuntime' in report.header) return false;
  } catch { /* fall through to the filesystem probe */ }
  return fs.existsSync('/etc/alpine-release')
    || fs.existsSync('/lib/ld-musl-x86_64.so.1')
    || fs.existsSync('/lib/ld-musl-aarch64.so.1');
}

/** Platform slot we ship a native binary for (or null for unknown targets). */
export function shippedPlatformDir() {
  const plat = os.platform();
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  if (plat === 'linux') return `linux-${arch}${isMusl() ? '-musl' : ''}`;
  if (plat === 'win32') return `win32-${arch}`;
  if (plat === 'darwin') return `darwin-${arch}`;
  return null;
}

/**
 * Locate the bundled laya-serve binary, or null when there is none.
 *
 * Order: LAYA_SERVE_BIN -> bundled binary for this platform (probing both
 * arches, since Bun on Windows-ARM64 reports x64) -> PATH. On musl only the
 * musl bundle is ever considered: the glibc binary cannot load there.
 */
export function resolveBinaryOrNull() {
  if (process.env.LAYA_SERVE_BIN) {
    return fs.existsSync(process.env.LAYA_SERVE_BIN) ? process.env.LAYA_SERVE_BIN : null;
  }
  const plat = os.platform();
  const musl = isMusl();
  const arches = os.arch() === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64'];
  const exe = plat === 'win32' ? 'laya-serve.exe' : 'laya-serve';

  const candidates = [];
  for (const arch of arches) {
    if (plat === 'linux') candidates.push(`linux-${arch}-musl`);
    if (musl) continue; // never fall back to a glibc binary on musl
    candidates.push(`${plat}-${arch}`);
  }

  for (const dir of candidates) {
    const base = path.join(__dirname, '..', 'dist', 'bin', dir);
    const legacy = path.join(__dirname, '..', 'bin', dir);
    // musl: prefer the self-extracting bundle (ONE file, libs inside).
    if (dir.endsWith('-musl')) {
      for (const root of [base, legacy]) {
        const bundle = path.join(root, 'laya-serve.bundle');
        if (fs.existsSync(bundle)) return bundle;
      }
    }
    for (const root of [base, legacy]) {
      const local = path.join(root, exe);
      if (fs.existsSync(local)) return local;
    }
  }
  return null;
}

/**
 * Resolve the binary or throw an actionable error. The native binary is the
 * primary backend - silently running the wasm fallback instead would hide a
 * broken install, so this fails loudly.
 */
export function resolveBinary() {
  const found = resolveBinaryOrNull();
  if (found) return found;

  // last resort: a dev build on PATH
  if (!process.env.LAYA_SERVE_BIN && process.env.LAYA_ALLOW_PATH_BIN === '1') return 'laya-serve';

  const slot = shippedPlatformDir();
  throw new Error(
    [
      'laya-serve binary not found - the native backend is the primary path and must not silently fall back to wasm.',
      `Expected dist/bin/${slot}/${os.platform() === 'win32' ? 'laya-serve.exe' : 'laya-serve'} (or dist/bin/${slot}/laya-serve.bundle on musl).`,
      'Fix: reinstall the package, or build it with `cargo build --release` (see BUILD.md), or point LAYA_SERVE_BIN at a binary.',
      'Only browsers should use the wasm fallback (backend: "wasm").'
    ].join('\n')
  );
}

/**
 * True when a bundled `laya-serve` binary is available for this platform
 * (as opposed to the PATH fallback). Tests use this to skip the native
 * backend on checkouts that have not built it.
 */
export function hasBundledBinary() {
  return resolveBinaryOrNull() !== null;
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
      let errBuf = '';
      proc.stderr.on('data', (d) => {
        // keep the tail for diagnostics; too chatty to forward by default
        errBuf = (errBuf + d.toString()).slice(-16000);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn laya-serve (${bin}): ${err.message}`));
      });
      proc.on('exit', (code) => {
        if (!this.url) {
          clearTimeout(timer);
          // Include the child's stderr: a Rust panic exits 101 and the reason
          // is only visible there, so without it debugging CI is guesswork.
          const detail = errBuf.trim().slice(-2000);
          reject(new Error(
            `laya-serve exited before ready (code ${code}, bin: ${bin})` +
            (detail ? `\n--- laya-serve stderr ---\n${detail}` : '\n(no stderr)')
          ));
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
