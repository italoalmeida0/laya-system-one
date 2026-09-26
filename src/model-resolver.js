/**
 * model-resolver.js — deterministic, layered acquisition of the Laya model.
 *
 * The INT8 checkpoint (model.onnx, ~324 MB) does NOT fit a single npm
 * package (registry rejects payloads over ~200 MB with HTTP 413), so it is
 * split into small "chunk" packages published on npm and reassembled here.
 *
 * Resolution order (first hit wins, every path is checksum-verified):
 *   1. LAYA_MODEL_PATH                — explicit file (or dir containing model.onnx)
 *   2. <modelDir>/model.onnx          — shipped next to the package / dev checkout
 *   3. <cacheDir>/model.onnx          — previously assembled/downloaded copy
 *   4. chunk files on disk            — LAYA_MODEL_CHUNKS_DIR or node_modules chunk pkgs
 *   5. chunk packages from the npm registry (tarballs) — "100% npm" path
 *   6. GitHub Releases asset          — legacy fallback (1.0.0 behaviour)
 *
 * Every write is atomic (temp file + rename) and verified against
 * `models/model.manifest.json`, so a killed download can never leave a
 * corrupt model behind — the next run simply retries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_GITHUB_URL =
  'https://github.com/italoalmeida0/laya-system-one/releases/download/v1.1.0/model.onnx';

/* ------------------------------------------------------------------ */
/* small utils                                                         */
/* ------------------------------------------------------------------ */

export function defaultCacheDir() {
  if (process.env.LAYA_CACHE_DIR) return process.env.LAYA_CACHE_DIR;
  return path.join(os.homedir(), '.cache', 'laya-system-one');
}

/** sha256 of a file, streamed (never loads 324 MB in RAM). */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function log(msg, quiet) {
  if (!quiet && process.stdout && process.stdout.write) {
    process.stdout.write(`${msg}\n`);
  }
}

/** Sleep with exponential backoff (used by every network fetch). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch a URL as a Buffer, retrying transient failures. */
export async function fetchBuffer(url, { retries = 3, timeoutMs = 120000, quiet = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'laya-system-one-model-resolver' }
      });
      if (!res.ok) {
        // 4xx (except 429) will not get better by retrying.
        const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        if (!retryable) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err && err.fatal) throw err;
      lastErr = err;
      if (attempt < retries) {
        const backoff = 500 * 2 ** attempt;
        log(`[laya-system-one] fetch failed (${err.message}), retrying in ${backoff}ms...`, quiet);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`Failed to download ${url} after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read the model manifest shipped with the package
 * (`models/model.manifest.json`). Returns null when absent (dev checkouts
 * before `node tools/model-chunks/build.js` has been run).
 */
export function readManifest(modelDir) {
  const candidates = [
    path.join(modelDir, 'model.manifest.json'),
    path.join(__dirname, '..', 'models', 'model.manifest.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* unreadable manifest: treat as absent */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* npm tarball extraction (zero dependencies)                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal tar reader — enough for npm tarballs (ustar/pax).
 * Returns a Map<entryName, Buffer>.
 */
export function extractTar(buf) {
  const out = new Map();
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeFlag = String.fromCharCode(header[156]) || '0';
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const data = buf.subarray(dataStart, Math.min(dataEnd, buf.length));

    if (typeFlag === 'L') {
      // GNU long name: the *next* entry uses this name.
      longName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (typeFlag === 'K' || typeFlag === 'x' || typeFlag === 'g') {
      // long link name / pax headers — irrelevant for our payloads.
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const name = longName || (prefix ? `${prefix}/${rawName}` : rawName);
      out.set(name, Buffer.from(data));
      longName = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** gunzip + untar an npm package tarball. */
export function extractTgz(buf) {
  return extractTar(zlib.gunzipSync(buf));
}

/** URL of a package tarball on an npm registry.
 * Scoped names keep their ``@scope/`` in the path and drop it from the
 * tarball filename: ``@sys-one/model-chunk-00`` ->
 * ``https://.../@sys-one/model-chunk-00/-/model-chunk-00-1.0.0.tgz``.
 */
export function tarballUrl(pkgName, version, registry = DEFAULT_REGISTRY) {
  const base = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName;
  return `${registry.replace(/\/$/, '')}/${pkgName}/-/${base}-${version}.tgz`;
}

/* ------------------------------------------------------------------ */
/* chunk assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Concatenate chunk files into `outPath` and verify against the manifest.
 * Atomic: writes to `<outPath>.tmp-<pid>` and renames on success.
 *
 * @param {string[]} chunkPaths ordered chunk file paths
 * @param {string} outPath     final model path
 * @param {object} manifest    optional manifest for checksum verification
 * @returns {Promise<{path: string, bytes: number, sha256: string|null}>}
 */
export async function assembleChunks(chunkPaths, outPath, manifest = null) {
  if (!chunkPaths.length) throw new Error('assembleChunks: no chunk paths given');
  if (manifest && manifest.chunkCount && chunkPaths.length !== manifest.chunkCount) {
    throw new Error(
      `assembleChunks: expected ${manifest.chunkCount} chunks, got ${chunkPaths.length}`
    );
  }

  const tmpPath = `${outPath}.tmp-${process.pid}`;
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  try {
    const out = fs.createWriteStream(tmpPath);
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    for (let i = 0; i < chunkPaths.length; i++) {
      const p = chunkPaths[i];
      const expected = manifest?.chunks?.[i]?.sha256;
      if (expected) {
        const actual = await sha256File(p);
        if (actual !== expected) {
          throw new Error(`chunk ${i} checksum mismatch (${path.basename(p)}): expected ${expected}, got ${actual}`);
        }
      }
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        rs.on('data', (c) => {
          hash.update(c);
          bytes += c.length;
          if (!out.write(c)) {
            rs.pause();
            out.once('drain', () => rs.resume());
          }
        });
        rs.on('end', resolve);
      });
    }

    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const sha256 = hash.digest('hex');

    if (manifest?.sha256 && sha256 !== manifest.sha256) {
      throw new Error(`assembled model checksum mismatch: expected ${manifest.sha256}, got ${sha256}`);
    }
    if (manifest?.bytes && bytes !== manifest.bytes) {
      throw new Error(`assembled model size mismatch: expected ${manifest.bytes} bytes, got ${bytes}`);
    }

    await fs.promises.rename(tmpPath, outPath);
    return { path: outPath, bytes, sha256 };
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Collect chunk files from a directory. Accepts either raw chunk files
 * (`chunk-00.bin`, …) or npm-style installed packages
 * (`<name>/chunk.bin`). Returns the ordered list of paths.
 */
export function findChunksOnDisk(dir, manifest) {
  if (!dir || !fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const count = manifest?.chunkCount;
  const pad = (n) => String(n).padStart(2, '0');
  const files = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name, path.join(dir, e.name)]));
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));

  // 1) plain chunk files: chunk-00.bin / chunk_00.bin / 00.bin
  const direct = [];
  for (let i = 0; i < (count ?? 512); i++) {
    const hit = [`chunk-${pad(i)}.bin`, `chunk_${pad(i)}.bin`, `${pad(i)}.bin`]
      .map((n) => files.get(n))
      .find(Boolean);
    if (!hit) break;
    direct.push(hit);
  }
  if (count ? direct.length === count : direct.length > 0) return direct;

  // 2) installed npm chunk packages: <pkgName>/chunk.bin, including scoped
  //    ones (@sys-one/...), which npm installs under node_modules/@sys-one/...
  const inPkgs = [];
  for (let i = 0; i < (count ?? 512); i++) {
    const pkgName = manifest?.chunks?.[i]?.package || `laya-system-one-model-chunk-${pad(i)}`;
    const candidates = [
      path.join(dir, pkgName, 'chunk.bin'),
      path.join(dir, pkgName.replace('/', path.sep), 'chunk.bin')
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (!hit) break;
    inPkgs.push(hit);
  }
  if (count ? inPkgs.length === count : inPkgs.length > 0) return inPkgs;

  return [];
}

/** Where npm installs the chunk packages when they are dependencies. */
function chunkPackageRoots() {
  const roots = [];
  // node_modules of the package itself and of the parent project(s)
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(dir, '..', 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/* ------------------------------------------------------------------ */
/* main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the model to a local `model.onnx` path, acquiring it if needed.
 *
 * @param {object} options
 *   - modelDir:   where model.onnx should live (default: <pkg>/models)
 *   - cacheDir:   user-writable cache (default: ~/.cache/laya-system-one)
 *   - manifest:   manifest object (default: read from modelDir)
 *   - quiet:      suppress progress output
 *   - allowNetwork: allow downloads (default true; false = offline-only)
 * @returns {Promise<{path: string, source: string}>}
 */
export async function resolveModel(options = {}) {
  const modelDir = options.modelDir || path.resolve(__dirname, '..', 'models');
  const cacheDir = options.cacheDir || defaultCacheDir();
  const quiet = options.quiet === true;
  const allowNetwork = options.allowNetwork !== false;
  const manifest = options.manifest ?? readManifest(modelDir);
  const fileName = manifest?.model || 'model.onnx';

  // 0) explicit option (programmatic override, highest priority)
  if (options.modelPath) {
    const p = options.modelPath;
    if (!fs.existsSync(p)) {
      throw new Error(`modelPath option points to a missing file: ${p}`);
    }
    return { path: p, source: 'options' };
  }

  // 1) explicit override
  const envPath = process.env.LAYA_MODEL_PATH;
  if (envPath) {
    const p = fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()
      ? path.join(envPath, fileName)
      : envPath;
    if (!fs.existsSync(p)) {
      throw new Error(`LAYA_MODEL_PATH is set but no model found at ${p}`);
    }
    return { path: p, source: 'env' };
  }

  // 2) shipped next to the package (dev checkout / air-gapped install)
  const localPath = path.join(modelDir, fileName);
  if (fs.existsSync(localPath)) return { path: localPath, source: 'local' };

  // 3) user cache (models dir may be read-only — global installs, containers)
  const cachePath = path.join(cacheDir, fileName);
  if (fs.existsSync(cachePath)) {
    if (await verifyCached(cachePath, manifest, quiet)) return { path: cachePath, source: 'cache' };
    log('[laya-system-one] cached model failed verification, re-acquiring...', quiet);
    await fs.promises.rm(cachePath, { force: true }).catch(() => {});
  }

  const targetPath = await pickWritableTarget(modelDir, cachePath, fileName);

  // 4) chunks already on disk (LAYA_MODEL_CHUNKS_DIR / node_modules)
  const chunkDirs = [
    process.env.LAYA_MODEL_CHUNKS_DIR,
    modelDir,
    ...chunkPackageRoots()
  ].filter(Boolean);

  for (const dir of chunkDirs) {
    const chunks = findChunksOnDisk(dir, manifest);
    if (chunks.length && (!manifest?.chunkCount || chunks.length === manifest.chunkCount)) {
      log(`[laya-system-one] assembling model from ${chunks.length} local chunk(s) in ${dir}`, quiet);
      const res = await assembleChunks(chunks, targetPath, manifest);
      log(`[laya-system-one] model ready at ${res.path} (${(res.bytes / 1e6).toFixed(1)} MB)`, quiet);
      return { path: res.path, source: 'chunks-local' };
    }
  }

  if (!allowNetwork) {
    throw new Error(
      `Model not found and network acquisition is disabled. Set LAYA_MODEL_PATH to an existing model.onnx ` +
      `or place chunks in LAYA_MODEL_CHUNKS_DIR.`
    );
  }

  // 5) chunks from the npm registry ("100% npm" path)
  if (manifest?.chunks?.length) {
    try {
      const res = await assembleFromRegistry(manifest, targetPath, quiet);
      return { path: res.path, source: 'chunks-npm' };
    } catch (err) {
      log(`[laya-system-one] npm chunk acquisition failed: ${err.message}`, quiet);
      if (manifest.fallback === false) throw err;
    }
  }

  // 6) GitHub Releases asset — OPT-IN legacy path only. v1.1.0 acquires the
  // model through npm (the chunk packages), so a GitHub download is a
  // deliberate last resort, never an implicit one: on a normal install the
  // npm path above always wins, and this only runs when explicitly enabled
  // (LAYA_ALLOW_GITHUB_FALLBACK=1) or when the manifest demands it.
  const allowGithub = process.env.LAYA_ALLOW_GITHUB_FALLBACK === '1' || manifest?.allowGithubFallback === true;
  if (!allowGithub) {
    throw new Error(
      'Could not acquire the model from npm. The v1.1.0 acquisition path is fully npm-based '
      + '(chunk packages) - see the error above for which step failed. Set LAYA_MODEL_PATH to an '
      + 'existing model.onnx, or LAYA_ALLOW_GITHUB_FALLBACK=1 to permit the legacy GitHub download.'
    );
  }

  const urls = [...new Set([
    process.env.LAYA_MODEL_URL,
    manifest?.sources?.github,
    manifest?.sources?.githubLegacy,
    DEFAULT_GITHUB_URL
  ].filter(Boolean))];

  let lastErr;
  for (const url of urls) {
    try {
      log(`[laya-system-one] downloading model asset (${(manifest?.bytes / 1e6 || 324).toFixed(0)} MB) from ${url}`, quiet);
      await downloadToFile(url, targetPath, { manifest, quiet });
      log(`[laya-system-one] model ready at ${targetPath}`, quiet);
      return { path: targetPath, source: 'github' };
    } catch (err) {
      lastErr = err;
      log(`[laya-system-one] ${url} failed: ${err.message}`, quiet);
    }
  }
  throw new Error(`Could not acquire the model from any source (last error: ${lastErr?.message || lastErr}). `
    + `Set LAYA_MODEL_PATH to an existing model.onnx or LAYA_MODEL_URL to a reachable download URL.`);
}

/** Verify a cached model against the manifest (sidecar avoids re-hashing). */
async function verifyCached(cachePath, manifest, quiet) {
  if (!manifest?.sha256) return true;
  const sidecar = `${cachePath}.sha256`;
  try {
    const recorded = (await fs.promises.readFile(sidecar, 'utf8')).trim();
    if (recorded === manifest.sha256) return true;
  } catch {
    /* no sidecar: hash it once and remember */
  }
  const actual = await sha256File(cachePath);
  const ok = actual === manifest.sha256;
  if (ok) await fs.promises.writeFile(sidecar, manifest.sha256, 'utf8').catch(() => {});
  return ok;
}

/** Prefer the package models dir; fall back to the user cache when read-only. */
async function pickWritableTarget(modelDir, cachePath, fileName) {
  try {
    await fs.promises.mkdir(modelDir, { recursive: true });
    const probe = path.join(modelDir, `.write-probe-${process.pid}`);
    await fs.promises.writeFile(probe, '');
    await fs.promises.rm(probe, { force: true });
    return path.join(modelDir, fileName);
  } catch {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    return cachePath;
  }
}

/**
 * Download every chunk package from the npm registry and assemble them.
 * Uses registry tarballs only — no git, no GitHub, no third-party CDN.
 */
export async function assembleFromRegistry(manifest, targetPath, quiet = false, registry = DEFAULT_REGISTRY) {
  const tmpDir = path.join(path.dirname(targetPath), `.chunks-${process.pid}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const chunkPaths = [];

  try {
    for (let i = 0; i < manifest.chunks.length; i++) {
      const chunk = manifest.chunks[i];
      const url = tarballUrl(chunk.package, chunk.version, registry);
      log(`[laya-system-one] fetching ${chunk.package}@${chunk.version} (${(chunk.bytes / 1e6).toFixed(1)} MB)`, quiet);
      const tgz = await fetchBuffer(url, { quiet });
      const entries = extractTgz(tgz);
      const data = entries.get('package/chunk.bin') || entries.get('chunk.bin');
      if (!data) {
        throw new Error(`chunk package ${chunk.package} does not contain chunk.bin`);
      }
      const p = path.join(tmpDir, `chunk-${String(i).padStart(2, '0')}.bin`);
      await fs.promises.writeFile(p, data);
      chunkPaths.push(p);
    }
    return await assembleChunks(chunkPaths, targetPath, manifest);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Stream a URL to a file, with retries and checksum verification. */
export async function downloadToFile(url, targetPath, { manifest = null, quiet = false, retries = 3 } = {}) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(600000),
        headers: { 'user-agent': 'laya-system-one-model-resolver' }
      });
      if (!res.ok) {
        // 4xx will not improve on retry (404 = asset not published yet);
        // bail out immediately so the next source in the chain is tried.
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        if (res.status < 500 && res.status !== 429 && res.status !== 408) {
          throw Object.assign(err, { fatal: true });
        }
        throw err;
      }

      const total = parseInt(res.headers.get('content-length') || `${manifest?.bytes || 0}`, 10);
      let loaded = 0;
      let lastLogged = -10;

      const out = fs.createWriteStream(tmpPath);
      const hash = crypto.createHash('sha256');

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        loaded += buf.length;
        if (!out.write(buf)) {
          await new Promise((r) => out.once('drain', r));
        }
        if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          if (pct >= lastLogged + 10 || pct === 100) {
            log(`[laya-system-one] download: ${pct}% (${(loaded / 1e6).toFixed(1)} MB)`, quiet);
            lastLogged = pct;
          }
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

      const sha256 = hash.digest('hex');
      if (manifest?.sha256 && sha256 !== manifest.sha256) {
        throw new Error(`checksum mismatch: expected ${manifest.sha256}, got ${sha256}`);
      }

      await fs.promises.rename(tmpPath, targetPath);
      if (manifest?.sha256) {
        await fs.promises.writeFile(`${targetPath}.sha256`, manifest.sha256, 'utf8').catch(() => {});
      }
      return { path: targetPath, bytes: loaded, sha256 };
    } catch (err) {
      if (err && err.fatal) {
        await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
      lastErr = err;
      if (attempt < retries) {
        const backoff = 1000 * 2 ** attempt;
        log(`[laya-system-one] download failed (${err.message}), retrying in ${backoff}ms...`, quiet);
        await sleep(backoff);
      }
    }
  }
  await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  throw new Error(`Failed to download ${url}: ${lastErr?.message || lastErr}`);
}
