/**
 * Shared test helpers — everything here is deterministic and offline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import { hasBundledBinary } from '../../src/laya-native.js';

/**
 * The bundled native binary is the PRIMARY inference path; the wasm engine
 * is a browser/edge-case safety net. Tests must therefore exercise `native`
 * on every platform we ship a binary for, and must FAIL (not silently skip)
 * when that binary is missing - a silent fallback would hide a broken
 * install. Set LAYA_ALLOW_WASM_FALLBACK=1 to explicitly accept the fallback
 * (e.g. on a platform whose binary is not built yet).
 */
export const WARM_FALLBACK = process.env.LAYA_ALLOW_WASM_FALLBACK === '1';
export const HAS_NATIVE = hasBundledBinary();

if (!HAS_NATIVE && !WARM_FALLBACK) {
  console.warn(
    '[tests] WARNING: no bundled laya-serve binary for this platform. ' +
    'Native-backend tests will run and FAIL by design (wasm fallback is opt-in via LAYA_ALLOW_WASM_FALLBACK=1).'
  );
}

/** Backend for end-to-end tests: native, always - unless the fallback is opted into. */
export const E2E_BACKEND = HAS_NATIVE ? 'native' : (WARM_FALLBACK ? 'wasm' : 'native');

/** Skip reason for native-only tests, or false (run them). */
export const NATIVE_SKIP = HAS_NATIVE
  ? false
  : (WARM_FALLBACK ? 'no bundled laya-serve binary (wasm fallback explicitly allowed)' : false);

export function fakeTokenizer() {
  const vocab = new Map();
  const tok = (text, _opts = {}) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const ids = words.map((w) => {
      if (!vocab.has(w)) vocab.set(w, 100 + vocab.size);
      return vocab.get(w);
    });
    return { input_ids: { data: Int32Array.from(ids) } };
  };
  tok.mask_token = '<mask>';
  tok.mask_token_id = 4;
  tok.cls_token_id = 2;
  tok.sep_token_id = 1;
  tok._vocab = vocab;
  return tok;
}

/**
 * Fake engine returning a fixed logits row per question (and using the
 * marker count to know how many scores the answer decoder will read).
 */
export function mockEngine(rows, config = {}) {
  return {
    config: {
      max_len: 1024,
      head_max_len: 256,
      temperature: [1.0, 1.0, 1.0],
      ...config
    },
    calls: [],
    async run(items) {
      this.calls.push(items);
      return items.map((item, i) => {
        const row = Array.isArray(rows) ? rows[i % rows.length] : rows;
        // repeat/truncate to the marker count the decoder will consume
        const k = item.markers.length;
        return Array.from({ length: k }, (_, j) => row[j % row.length]);
      });
    }
  };
}

/** Create (and register cleanup for) a scratch directory. */
export function makeTempDir(prefix = 'laya-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Deterministic pseudo-random bytes (same seed -> same file). */
export function pseudoRandomBuffer(size, seed = 42) {
  const out = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift32
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Ask the OS for a free TCP port (avoids the "random range" flakiness where
 * a hardcoded port can collide with a live socket).
 */
export function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Deterministic HTTP client for protocol tests.
 *
 * Uses `node:http` with `agent: false` (no connection pooling): the global
 * `fetch` keeps sockets alive per origin, and a socket killed by a previous
 * test's `close()` poisons the pool for the next server on the same port.
 */
export function request(baseUrl, reqPath, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(reqPath, baseUrl);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      agent: false,
      headers: {
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: () => {
            try { return JSON.parse(text); } catch { return null; }
          }
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** Build a minimal ustar tar archive (npm-compatible) for tar-parser tests. */
export function makeTar(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');      // mode
    header.write('0000000\0', 108, 8, 'utf8');      // uid
    header.write('0000000\0', 116, 8, 'utf8');      // gid
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('0'.repeat(11) + '\0', 136, 12, 'utf8'); // mtime
    header.write('        ', 148, 8, 'utf8');       // checksum placeholder
    header.write('0', 156, 1, 'utf8');              // type: regular file
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');

    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

    blocks.push(header);
    const pad = (512 - (data.length % 512)) % 512;
    blocks.push(data, Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // end-of-archive
  return Buffer.concat(blocks);
}
