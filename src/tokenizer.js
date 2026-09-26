import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpeTokenizer, makeTokenizerCallable } from './bpe-tokenizer.js';

// WeakMap<tokenizer, Map<text, number[]>> - avoids leaking tokenizers.
const _encodeCache = new WeakMap();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const dir = modelDir || path.resolve(__dirname, '../models');
  const isRemote = /^(https?|file):/.test(String(dir));
  const src = isRemote ? String(dir).replace(/\/?$/, '/tokenizer.json') : path.join(dir, 'tokenizer.json');

  let json;
  if (isRemote) {
    json = await (await fetch(src)).json();
  } else {
    const fs = await import('node:fs');
    json = JSON.parse(await fs.promises.readFile(src, 'utf8'));
  }
  return makeTokenizerCallable(new BpeTokenizer(json));
}
