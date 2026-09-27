import { BpeTokenizer, makeTokenizerCallable } from './bpe-tokenizer.js';
import { isBrowser } from './env.js';

// Node builtins are loaded lazily: a static import of node:path makes this
// module unresolvable in a browser, even though the browser path only ever
// fetches the tokenizer over HTTP.
let _path = null;
async function nodePath() {
  if (!_path) _path = (await import('node:path')).default;
  return _path;
}

// WeakMap<tokenizer, Map<text, number[]>> - avoids leaking tokenizers.
const _encodeCache = new WeakMap();

/** The package's models/ directory, as an absolute path or a URL. */
async function defaultModelDir() {
  if (isBrowser) return new URL('../models/', import.meta.url).href;
  const path = await nodePath();
  const { fileURLToPath } = await import('node:url');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models');
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
  const dir = modelDir || await defaultModelDir();
  // Only a real URL is fetched. Two things look like one but are not:
  //   - an absolute filesystem path, which starts with '/' on Linux (every CI
  //     job tried fetch('/home/runner/.../tokenizer.json') and got Invalid URL);
  //   - a Windows drive path, where 'C:' matches a URL scheme pattern.
  const isUrl = /^(https?|file|data|blob):/i.test(dir);
  // In a browser everything is a URL, including a relative one.
  const fetchIt = isUrl || isBrowser;

  let json;
  if (fetchIt) {
    const src = dir.replace(/\/?$/, '/') + 'tokenizer.json';
    const res = await fetch(src);
    if (!res.ok) throw new Error(`could not fetch the tokenizer: ${res.status} ${src}`);
    json = await res.json();
  } else {
    const path = await nodePath();
    const fs = await import('node:fs');
    json = JSON.parse(await fs.promises.readFile(path.join(dir, 'tokenizer.json'), 'utf8'));
  }
  return makeTokenizerCallable(new BpeTokenizer(json));
}
