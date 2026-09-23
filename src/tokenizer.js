import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as ort from 'onnxruntime-web';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure ONNX runtime symbol is bound for web build compatibility in Bun/Web
const ORT_SYMBOL = Symbol.for('onnxruntime');
if (!(ORT_SYMBOL in globalThis)) {
  globalThis[ORT_SYMBOL] = ort;
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

  const opts = renderOptions(q);
  const ins = String(q.ins).replaceAll(maskTok, ' ');

  const headEncoded = tok(`${q.t} question: ${ins}`, { add_special_tokens: false });
  let headIds = Array.from(headEncoded.input_ids.data || headEncoded.input_ids).map(Number);

  const optIds = [];
  for (const opt of opts) {
    const optEncoded = tok(` ${opt.replaceAll(maskTok, ' ')}`, { add_special_tokens: false });
    const rawIds = Array.from(optEncoded.input_ids.data || optEncoded.input_ids).map(Number);
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
  const isBun = typeof Bun !== 'undefined';

  if (isBun) {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@huggingface/transformers');
    const webPath = resolved.replace(/transformers\.node\.(cjs|mjs)/, 'transformers.web.js');
    const mod = await import(pathToFileURL(webPath).href);
    return await mod.AutoTokenizer.from_pretrained(pathToFileURL(dir).href);
  } else {
    const mod = await import('@huggingface/transformers');
    return await mod.AutoTokenizer.from_pretrained(dir, { local_files_only: true });
  }
}
