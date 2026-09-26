#!/usr/bin/env node
// tokenizer-diff.js - differential test for the pure-JS BPE tokenizer.
//
// Compares src/bpe-tokenizer.js against the golden fixtures produced by the
// reference implementation (the `tokenizers` crate binding, the same version
// the native laya-serve binary links):
//
//   python tools/tokenizer-oracle.py models/tokenizer.json \
//     < tests/fixtures/tokenizer-corpus.json > tests/fixtures/tokenizer-golden.json
//
//   node tools/tokenizer-diff.js            # verify (CI)
//   node tools/tokenizer-diff.js --corpus   # also print token strings
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpeTokenizer } from '../src/bpe-tokenizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tokenizer-corpus.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tokenizer-golden.json'), 'utf8'));
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'models/tokenizer.json'), 'utf8'));

const t0 = Date.now();
const mine = new BpeTokenizer(json);
console.log(`[diff] pure-JS tokenizer built in ${Date.now() - t0}ms (vocab ${mine.vocab.size}, merges ${mine.merges.size})`);

const rev = mine.reverseVocab;
const show = (ids) => ids.map((i) => rev.get(i) ?? `#${i}`).join(' | ');

let checked = 0;
let mismatches = 0;

for (let i = 0; i < corpus.length; i++) {
  const [text, addSpecial] = corpus[i];
  const expected = golden[i];
  const actual = Array.from(mine.encode(text, { addSpecialTokens: addSpecial }));
  checked++;
  const same = actual.length === expected.length && actual.every((v, j) => v === expected[j]);
  if (same) continue;
  mismatches++;
  console.log(`\n[diff] MISMATCH #${i} add_special=${addSpecial} text=${JSON.stringify(text).slice(0, 70)}`);
  console.log(`  js  (${actual.length}): ${show(actual).slice(0, 220)}`);
  console.log(`  ref (${expected.length}): ${show(expected).slice(0, 220)}`);
}

console.log(`\n[diff] checked ${checked} cases, ${mismatches} mismatch(es)`);
process.exit(mismatches ? 1 : 0);
