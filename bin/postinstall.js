#!/usr/bin/env node
/**
 * postinstall — cheap, silent-ish and never fatal.
 *
 * 1. Restores the executable bit on the bundled laya-serve binaries
 *    (npm does not preserve file modes, so native binaries would not run).
 * 2. Optionally pre-fetches the INT8 model when explicitly requested
 *    (LAYA_PREFETCH_MODEL=1). By default the model is acquired lazily on
 *    first use — that keeps `npm install` fast and lets CI/docker builds
 *    decide when to pay the ~324 MB download.
 *
 * Set LAYA_SKIP_MODEL_DOWNLOAD=1 to silence even the hint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'models');

const SKIPPED = process.platform === 'win32'
  || process.env.LAYA_SKIP_MODEL_DOWNLOAD === '1'
  || process.env.npm_config_ignore_scripts === 'true';

/** npm drops file modes — native binaries must be executable. */
function restoreExecBits() {
  if (process.platform === 'win32') return;
  const targets = [
    path.join(__dirname, 'cli.js'),
    path.join(__dirname, 'postinstall.js'),
    path.join(__dirname, '..', 'dist', 'bin')
  ];
  for (const t of targets) {
    try {
      const stat = fs.statSync(t);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(t)) {
          const p = path.join(t, entry);
          try {
            if (fs.statSync(p).isFile() && !entry.endsWith('.exe') && !entry.endsWith('.bundle')) {
              fs.chmodSync(p, 0o755);
            }
          } catch { /* ignore */ }
        }
      } else {
        fs.chmodSync(t, 0o755);
      }
    } catch { /* ignore */ }
  }
}

async function maybePrefetch() {
  if (SKIPPED) return;

  if (process.env.LAYA_PREFETCH_MODEL !== '1') {
    console.log('[laya-system-one] model will be downloaded on first use (~324 MB, once).');
    console.log('[laya-system-one] run with LAYA_PREFETCH_MODEL=1 to fetch it now.');
    return;
  }

  console.log('[laya-system-one] LAYA_PREFETCH_MODEL=1 — pre-fetching model asset...');
  try {
    const { resolveModel } = await import('../src/model-resolver.js');
    const res = await resolveModel({ modelDir: MODELS_DIR });
    console.log(`[laya-system-one] model ready: ${res.path} (source: ${res.source})`);
  } catch (err) {
    // Never break installation: the model is fetched again on first use.
    console.warn(`[laya-system-one] pre-fetch skipped: ${err?.message || err}`);
  }
}

try {
  restoreExecBits();
} catch { /* ignore */ }

maybePrefetch().catch(() => {});
