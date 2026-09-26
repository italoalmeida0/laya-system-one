#!/usr/bin/env node
/**
 * model-chunks.js — split/assemble/publish the INT8 model as npm packages.
 *
 * Why: `model.onnx` (~324 MB) exceeds the npm registry payload limit
 * (HTTP 413 above ~200 MB), so it cannot ship inside `laya-system-one`.
 * Instead it is split into small chunk packages published to npm — the
 * package manager then becomes the model CDN (mirrors, proxies, caching,
 * checksums and retries all come for free, and nothing depends on git).
 *
 *   node tools/model-chunks.js build    [--chunk-mb 24] [--model-version 1.0.0]
 *   node tools/model-chunks.js assemble [--from <dir>] [--out <file>]
 *   node tools/model-chunks.js verify   [--model <file>]
 *   node tools/model-chunks.js publish  [--dry-run] [--registry <url>]
 *
 * `build` writes:
 *   models/model.manifest.json                          (shipped with the pkg)
 *   dist/model-chunks/<pkg>/package.json + chunk.bin    (one npm pkg per chunk)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  sha256File,
  assembleChunks,
  extractTgz,
  findChunksOnDisk,
  readManifest,
  tarballUrl,
  fetchBuffer
} from '../src/model-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'models');
const DEFAULT_OUT_DIR = path.join(ROOT, 'dist', 'release', 'model-chunks');
const DEFAULT_MANIFEST = path.join(MODELS_DIR, 'model.manifest.json');

// overridable so tests can sandbox the tool (see tests/unit/chunks-tool.test.js)
const outDir = () => process.env.LAYA_CHUNKS_OUT_DIR || DEFAULT_OUT_DIR;
const manifestPath = () => process.env.LAYA_CHUNKS_MANIFEST || DEFAULT_MANIFEST;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const pad = (n) => String(n).padStart(2, '0');
const MB = 1024 * 1024;

/** Manifest for read-back commands (honours the sandbox override). */
function loadManifest() {
  const p = manifestPath();
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return readManifest(MODELS_DIR);
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

async function cmdBuild(args) {
  const modelPath = args.model || path.join(MODELS_DIR, 'model.onnx');
  if (!fs.existsSync(modelPath)) {
    throw new Error(`model not found: ${modelPath}`);
  }
  const chunkBytes = Math.max(1, parseInt(args['chunk-mb'] || '24', 10)) * MB;
  const modelVersion = args['model-version'] || '1.0.0';
  const pkgPrefix = args.prefix || '@sys-one/laya-model-chunk';

  const stat = await fs.promises.stat(modelPath);
  const chunkCount = Math.ceil(stat.size / chunkBytes);
  console.log(`[chunks] model      : ${modelPath}`);
  console.log(`[chunks] size       : ${(stat.size / MB).toFixed(1)} MB`);
  console.log(`[chunks] chunk size : ${(chunkBytes / MB).toFixed(0)} MB -> ${chunkCount} chunk(s)`);
  console.log(`[chunks] hashing model (sha256)...`);
  const modelSha256 = await sha256File(modelPath);

  await fs.promises.rm(outDir(), { recursive: true, force: true });
  await fs.promises.mkdir(outDir(), { recursive: true });

  const chunks = [];
  const fd = await fs.promises.open(modelPath, 'r');
  try {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkBytes;
      const end = Math.min(start + chunkBytes, stat.size);
      const len = end - start;
      const buf = Buffer.allocUnsafe(len);
      await fd.read(buf, 0, len, start);

      const pkgName = `${pkgPrefix}-${pad(i)}`;
      // scoped packages live under a literal @scope/ dir in node_modules, but
      // these are generated locally: flatten to @scope__name so they stay in
      // one flat outDir (assembly then finds chunk.bin by manifest lookup).
      const pkgDir = path.join(outDir(), pkgName.replace('/', '__'));
      await fs.promises.mkdir(pkgDir, { recursive: true });
      await fs.promises.writeFile(path.join(pkgDir, 'chunk.bin'), buf);
      await fs.promises.writeFile(path.join(pkgDir, 'README.md'),
        `# ${pkgName}\n\nChunk ${i + 1}/${chunkCount} of the Laya System-One INT8 model.\n` +
        `Do not install directly — install \`laya-system-one\` and it reassembles the model for you.\n`);
      await fs.promises.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: pkgName,
        version: modelVersion,
        description: `Chunk ${i + 1}/${chunkCount} of the laya-system-one INT8 model (${modelSha256.slice(0, 12)})`,
        license: 'Apache-2.0',
        files: ['chunk.bin', 'README.md'],
        // model data only: never a dependency of anything, never runs code
        scripts: {},
        keywords: ['laya', 'model', 'chunk'],
        repository: {
          type: 'git',
          url: 'git+https://github.com/italoalmeida0/laya-system-one.git'
        }
      }, null, 2) + '\n');

      const sha256 = await sha256File(path.join(pkgDir, 'chunk.bin'));
      chunks.push({
        index: i,
        package: pkgName,
        version: modelVersion,
        bytes: len,
        sha256
      });
      console.log(`[chunks]   ${pkgName}: ${(len / MB).toFixed(1)} MB  sha256=${sha256.slice(0, 12)}…`);
    }
  } finally {
    await fd.close();
  }

  const manifest = {
    $comment: 'Generated by tools/model-chunks.js build — describes how to rebuild model.onnx from npm chunk packages.',
    model: 'model.onnx',
    version: modelVersion,
    bytes: stat.size,
    sha256: modelSha256,
    chunkCount,
    chunkBytes,
    chunks,
    sources: {
      npm: 'https://registry.npmjs.org',
      github: 'https://github.com/italoalmeida0/laya-system-one/releases/download/v1.1.0/model.onnx',
      githubLegacy: 'https://github.com/italoalmeida0/laya-system-one/releases/download/v1.0.0/model.onnx'
    }
  };

  await fs.promises.writeFile(
    manifestPath(),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  await fs.promises.writeFile(
    path.join(outDir(), 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  console.log(`[chunks] manifest: ${manifestPath()}`);
  console.log(`[chunks] packages: ${outDir()} (${chunkCount} x ~${(chunkBytes / MB).toFixed(0)} MB)`);
  console.log(`[chunks] done. Next: node tools/model-chunks.js publish --dry-run`);
}

/* ------------------------------------------------------------------ */
/* assemble / verify                                                   */
/* ------------------------------------------------------------------ */

async function collectChunks(args, manifest) {
  if (args.from) {
    const found = findChunksOnDisk(args.from, manifest);
    if (!found.length) throw new Error(`no chunks found in ${args.from}`);
    return found;
  }
  if (manifest?.chunks?.length) {
    // resolve from the built package dirs (offline, deterministic)
    const found = manifest.chunks.map((c) => path.join(outDir(), c.package.replace('/', '__'), 'chunk.bin'));
    if (found.every((p) => fs.existsSync(p))) return found;
  }
  const fallback = findChunksOnDisk(MODELS_DIR, manifest);
  if (fallback.length) return fallback;
  throw new Error('no chunk sources found — run `node tools/model-chunks.js build` first');
}

async function cmdAssemble(args) {
  const manifest = loadManifest();
  const chunks = await collectChunks(args, manifest);
  const out = args.out || path.join(MODELS_DIR, 'model.onnx');
  console.log(`[chunks] assembling ${chunks.length} chunk(s) -> ${out}`);
  const res = await assembleChunks(chunks, out, manifest);
  console.log(`[chunks] ok: ${(res.bytes / MB).toFixed(1)} MB sha256=${res.sha256}`);
}

async function cmdVerify(args) {
  const manifest = loadManifest();
  if (!manifest) throw new Error(`${manifestPath()} not found — run build first`);
  const modelPath = args.model || path.join(MODELS_DIR, 'model.onnx');
  console.log(`[chunks] verifying ${modelPath}`);
  console.log(`[chunks] expected sha256: ${manifest.sha256}`);
  const stat = await fs.promises.stat(modelPath);
  if (stat.size !== manifest.bytes) {
    throw new Error(`size mismatch: expected ${manifest.bytes}, got ${stat.size}`);
  }
  const actual = await sha256File(modelPath);
  if (actual !== manifest.sha256) throw new Error(`sha256 mismatch: got ${actual}`);
  console.log(`[chunks] OK — model matches the manifest`);
}

/* ------------------------------------------------------------------ */
/* publish                                                             */
/* ------------------------------------------------------------------ */

async function cmdPublish(args) {
  const manifest = loadManifest();
  if (!manifest) throw new Error(`${manifestPath()} not found — run build first`);
  const registry = args.registry || 'https://registry.npmjs.org';
  const dryRun = args['dry-run'] === true;

  // Sanity: every built chunk must match the manifest before publishing.
  for (const c of manifest.chunks) {
    const p = path.join(outDir(), c.package.replace('/', '__'), 'chunk.bin');
    const sha = await sha256File(p);
    if (sha !== c.sha256) throw new Error(`chunk ${c.package} drifted from manifest — rebuild`);
  }

  for (const c of manifest.chunks) {
    const pkgDir = path.join(outDir(), c.package.replace('/', '__'));
    const cmdArgs = ['publish', '--access', 'public', '--registry', registry];
    if (dryRun) cmdArgs.push('--dry-run');
    console.log(`[chunks] npm ${cmdArgs.join(' ')}  (${c.package}@${c.version})`);
    if (!dryRun) {
      execFileSync('npm', cmdArgs, { cwd: pkgDir, stdio: 'inherit', shell: process.platform === 'win32' });
    }
  }

  console.log(`[chunks] ${manifest.chunks.length} chunk package(s) ${dryRun ? 'checked (dry-run)' : 'published'}`);
  console.log(`[chunks] model tarball URL pattern: ${tarballUrl(manifest.chunks[0].package, manifest.chunks[0].version, registry)}`);
}

/* ------------------------------------------------------------------ */

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'build': return cmdBuild(args);
    case 'assemble': return cmdAssemble(args);
    case 'verify': return cmdVerify(args);
    case 'publish': return cmdPublish(args);
    case 'fetch': {
      // round-trip test of the registry path (uses published chunk packages)
      const manifest = loadManifest();
      const out = args.out || path.join(MODELS_DIR, 'model.from-npm.onnx');
      const registry = args.registry || 'https://registry.npmjs.org';
      for (const c of manifest.chunks) {
        const url = tarballUrl(c.package, c.version, registry);
        console.log(`[chunks] fetching ${url}`);
        const tgz = await fetchBuffer(url, {});
        const entries = extractTgz(tgz);
        const data = entries.get('package/chunk.bin');
        if (!data) throw new Error(`${c.package}: chunk.bin missing in tarball`);
        const p = path.join(outDir(), `fetch-${pad(c.index)}.bin`);
        await fs.promises.mkdir(outDir(), { recursive: true });
        await fs.promises.writeFile(p, data);
      }
      const paths = manifest.chunks.map((c) => path.join(outDir(), `fetch-${pad(c.index)}.bin`));
      const res = await assembleChunks(paths, out, manifest);
      console.log(`[chunks] fetched + assembled OK: ${res.path}`);
      return;
    }
    default:
      console.log('usage: node tools/model-chunks.js <build|assemble|verify|publish|fetch> [--chunk-mb N] [--model-version X] [--dry-run] [--from DIR] [--out FILE]');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`[chunks] ERROR: ${err.message || err}`);
  process.exit(1);
});
