/**
 * Equivalence tests for the pure-JS BPE tokenizer (src/bpe-tokenizer.js).
 *
 * The golden fixtures are produced by the reference implementation (the
 * `tokenizers` crate binding - the same version the native laya-serve binary
 * links) via tools/tokenizer-oracle.py. If these pass, the JS tokenizer is
 * token-for-token identical to the one inside the native binary, so the
 * wasm backend sees exactly the same input ids as the fast path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BpeTokenizer, makeTokenizerCallable } from '../../src/bpe-tokenizer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tokenizer-corpus.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tokenizer-golden.json'), 'utf8'));
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'models/tokenizer.json'), 'utf8'));

const tok = new BpeTokenizer(json);

test('tokenizer.json is the supported BPE + Metaspace pipeline', () => {
  assert.equal(json.model.type, 'BPE');
  assert.equal(json.model.dropout, null, 'dropout must be null (deterministic)');
  assert.equal(json.pre_tokenizer.type, 'Metaspace');
  assert.equal(json.pre_tokenizer.prepend_scheme, 'always');
  assert.equal(json.normalizer.type, 'Replace');
});

test('special token ids match the model contract', () => {
  assert.equal(tok.pad_token_id, 0);
  assert.equal(tok.sep_token_id, 1);
  assert.equal(tok.cls_token_id, 2);
  assert.equal(tok.mask_token_id, 4);
  assert.equal(tok.unkId, 3);
});

test('every corpus case matches the reference implementation byte-for-byte', () => {
  assert.equal(corpus.length, golden.length);
  const failures = [];
  for (let i = 0; i < corpus.length; i++) {
    const [text, addSpecial] = corpus[i];
    const actual = Array.from(tok.encode(text, { addSpecialTokens: addSpecial }));
    const expected = golden[i];
    const same = actual.length === expected.length && actual.every((v, j) => v === expected[j]);
    if (!same) {
      failures.push(`#${i} add_special=${addSpecial} ${JSON.stringify(text).slice(0, 50)}: got ${actual.length} ids, want ${expected.length}`);
    }
  }
  assert.deepEqual(failures, [], `tokenizer diverged from the reference:\n${failures.join('\n')}`);
});

test('encoding is deterministic (same input, same ids)', () => {
  for (const [text] of corpus.slice(0, 20)) {
    const a = Array.from(tok.encode(text));
    const b = Array.from(tok.encode(text));
    assert.deepEqual(a, b);
  }
});

test('special tokens are matched on the raw text', () => {
  // <mask> must come out as its own id even inside a sentence
  const ids = tok.encode('text with <mask> inside', { addSpecialTokens: false });
  assert.ok(ids.includes(tok.mask_token_id), 'the <mask> added token must be emitted');
});

test('literal delimiter runs match as added tokens, space runs do not', () => {
  const lit = tok.encode('a▁▁▁b', { addSpecialTokens: false });
  const spc = tok.encode('a   b', { addSpecialTokens: false });
  assert.equal(lit.length, 3, 'literal ▁▁▁ is one added token');
  assert.equal(spc.length, 4, 'three spaces become three separate ▁ tokens');
});

test('byte fallback covers unknown characters instead of <unk>', () => {
  const ids = tok.encode('�', { addSpecialTokens: false });
  assert.ok(!ids.includes(tok.unkId), 'byte fallback must not produce <unk>');
  assert.ok(ids.length >= 1);
});

test('fuse_unk collapses consecutive unknowns', () => {
  const ids = [];
  tok.pushId(ids, tok.unkId);
  tok.pushId(ids, tok.unkId);
  tok.pushId(ids, tok.unkId);
  assert.equal(ids.length, 1);
});

test('callable wrapper exposes the engine surface', () => {
  const fn = makeTokenizerCallable(tok);
  const out = fn('hello world', { add_special_tokens: false });
  assert.ok(out.input_ids.data instanceof Int32Array);
  assert.equal(fn.mask_token_id, 4);
  assert.equal(fn.cls_token_id, 2);
  assert.equal(fn.sep_token_id, 1);
});

test('huge inputs are capped by the caller and never hang', () => {
  const t0 = Date.now();
  const ids = tok.encode('a'.repeat(20000), { addSpecialTokens: false });
  assert.ok(ids.length > 0);
  assert.ok(Date.now() - t0 < 30000, 'encoding 20k chars must not take 30s');
});
