import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ORT_SYMBOL = Symbol.for('onnxruntime');

// WeakMap<tokenizer, Map<text, number[]>> — avoids leaking tokenizers.
const _encodeCache = new WeakMap();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bind the matching ORT symbol lazily so @huggingface/transformers finds a
// backend: onnxruntime-node server-side (Node/Bun), onnxruntime-web in the
// browser. Importing onnxruntime-web statically server-side would pull the
// full WASM bundle into memory and slow startup for nothing.
let _ortBound = false;
async function ensureOrtSymbol() {
  if (_ortBound || (ORT_SYMBOL in globalThis)) { _ortBound = true; return; }
  try {
    const isBrowser = typeof window !== 'undefined';
    const ort = await import(isBrowser ? 'onnxruntime-web' : 'onnxruntime-node');
    globalThis[ORT_SYMBOL] = ort.default || ort;
  } catch { /* transformers bundles its own copy; not fatal */ }
  _ortBound = true;
}

export const QTYPES = {
  choice: 0,
  score: 1,
  noul: 2,
};

export function serializeState(state) {
  if (typeof state === 'string') return state;
  return JSON.stringify(state);
}

export function renderCriterion(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function renderOptions(q) {
  const t = q.t;
  const crit = q.crit || {};

  if (t === 'choice') {
    return Object.entries(crit).map(([k, v]) => {
      if (v === null || v === undefined || v === '') return k;
      return `${k}: ${renderCriterion(v)}`;
    });
  }

  if (t === 'score') {
    if (Array.isArray(crit)) {
      return crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`);
    }
    return Object.entries(crit).map(([k, v]) => `level ${k}: ${renderCriterion(v)}`);
  }

  // noul
  const falseCrit = crit.false;
  const trueCrit = crit.true;
  const falseText = falseCrit ? renderCriterion(falseCrit) : 'no, the statement does not hold';
  const trueText = trueCrit ? renderCriterion(trueCrit) : 'yes, the statement holds';
  return [`false: ${falseText}`, `true: ${trueText}`];
}

export function buildSequence(tok, state, q, maxLen = 1024, headMaxLen = 256) {
  const maskTok = tok.mask_token || '<mask>';
  const maskTokenId = tok.mask_token_id ?? 4;
  const clsTokenId = tok.cls_token_id ?? 2;
  const sepTokenId = tok.sep_token_id ?? 1;

  // Per-tokenizer encode cache: Tetris/game loops repeat the same
  // instructions + option labels every frame. Caching avoids re-running
  // the 256k BPE encode (~1-2ms each) on every request.
  let cache = _encodeCache.get(tok);
  if (!cache) { cache = new Map(); _encodeCache.set(tok, cache); }
  const encodeCached = (text) => {
    let hit = cache.get(text);
    if (hit) return hit;
    const enc = tok(text, { add_special_tokens: false });
    hit = Array.from(enc.input_ids.data || enc.input_ids).map(Number);
    if (cache.size > 2000) cache.clear();
    cache.set(text, hit);
    return hit;
  };

  const opts = renderOptions(q);
  const ins = String(q.ins).replaceAll(maskTok, ' ');

  let headIds = encodeCached(`${q.t} question: ${ins}`);

  const optIds = [];
  for (const opt of opts) {
    const rawIds = encodeCached(` ${opt.replaceAll(maskTok, ' ')}`);
    optIds.push([maskTokenId, ...rawIds.slice(0, 48)]);
  }

  let optBudget = headMaxLen - optIds.reduce((sum, o) => sum + o.length, 0);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    for (let i = 0; i < optIds.length; i++) {
      optIds[i] = optIds[i].slice(0, per);
    }
    optBudget = headMaxLen - optIds.reduce((sum, o) => sum + o.length, 0);
  }

  headIds = headIds.slice(0, Math.max(8, optBudget));
  const ids = [clsTokenId, ...headIds, sepTokenId];
  const markers = [];

  for (const o of optIds) {
    markers.push(ids.length);
    ids.push(...o);
  }
  ids.push(sepTokenId);

  const room = Math.max(0, maxLen - ids.length - 1);
  const stateStr = serializeState(state).replaceAll(maskTok, ' ');
  // NOTE: state changes every frame, so it is NOT cached — only the
  // repeated question/option prefixes above benefit from the cache.
  const stEncoded = tok(stateStr, { add_special_tokens: false });
  const stIds = Array.from(stEncoded.input_ids.data || stEncoded.input_ids).map(Number);
  
  const stateTruncated = stIds.slice(0, room);
  ids.push(...stateTruncated, sepTokenId);

  const finalIds = ids.slice(0, maxLen);
  const finalMarkers = markers.filter(m => m < maxLen);

  return { ids: finalIds, markers: finalMarkers };
}

export async function loadTokenizer(modelDir) {
  await ensureOrtSymbol();
  const dir = modelDir || path.resolve(__dirname, '../models');
  const isBrowser = typeof window !== 'undefined';

  if (isBrowser) {
    // Browser has no fs: use the web build + file:// URL.
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@huggingface/transformers');
    const webPath = resolved.replace(/transformers\.node\.(cjs|mjs)/, 'transformers.web.js');
    const mod = await import(pathToFileURL(webPath).href);
    return await mod.AutoTokenizer.from_pretrained(pathToFileURL(dir).href);
  }

  // Bun: web build (no fs dependency on sharp; proven working on
  // Windows x64 + WSL2). Engine still uses onnxruntime-node natively.
  const isBun = typeof Bun !== 'undefined';
  if (isBun) {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@huggingface/transformers');
    const webPath = resolved.replace(/transformers\.node\.(cjs|mjs)/, 'transformers.web.js');
    const mod = await import(pathToFileURL(webPath).href);
    return await mod.AutoTokenizer.from_pretrained(pathToFileURL(dir).href);
  }

  // Node.js: node build + stub for the optional 'sharp' dependency
  // (images/audio only — never used for tokenizers). Sharp's native
  // binding may be missing/broken on some platforms (e.g. WSL2 ARM64
  // without libvips); redirect its resolution to a no-op stub.
  try {
    const M = await import('node:module').then(m => m.default || m);
    const origResolve = M._resolveFilename;
    let needStub = false;
    try {
      const req = createRequire(import.meta.url);
      req('sharp');
    } catch {
      needStub = true;
    }
    if (needStub) {
      M._resolveFilename = function (request, ...rest) {
        if (request === 'sharp') return path.join(__dirname, '_sharp_stub.cjs');
        return origResolve.call(this, request, ...rest);
      };
    }
  } catch { /* best-effort; import below will surface real errors */ }
  const mod = await import('@huggingface/transformers');
  return await mod.AutoTokenizer.from_pretrained(dir, { local_files_only: true });
}
