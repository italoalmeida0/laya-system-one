/**
 * Integration tests — real model + tokenizer.
 *
 * Engines are shared across tests (a wasm engine holds the ~309 MB weights
 * in memory; loading it per test would be slow and memory-hungry).
 *
 * Skipped automatically when models/model.onnx is absent. Set
 * LAYA_REQUIRE_MODEL=1 in CI to make a missing model a hard failure.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Laya } from '../../src/agent.js';
import { loadTokenizer, buildSequence, QTYPES } from '../../src/tokenizer.js';
import { NATIVE_SKIP } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_DIR = path.join(ROOT, 'models');
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, 'model.onnx'));

const skip = HAS_MODEL ? false : 'models/model.onnx not present';
const nativeSkip = HAS_MODEL ? NATIVE_SKIP : skip;

if (!HAS_MODEL && process.env.LAYA_REQUIRE_MODEL === '1') {
  throw new Error('LAYA_REQUIRE_MODEL=1 but models/model.onnx is missing');
}

// shared engines (one per backend)
const engines = new Map();
async function engineFor(backend) {
  if (!engines.has(backend)) {
    engines.set(backend, await Laya.load({ modelDir: MODEL_DIR, backend, wasmWorkers: 1 }));
  }
  return engines.get(backend);
}
after(async () => {
  for (const e of engines.values()) await e.close();
});

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: { billing: 'refunds and invoices', tech: 'bugs', sales: 'upgrades' }
  },
  severity: {
    type: 'score',
    instructions: 'Urgency (0=low, 1=mid, 2=high)?',
    criteria: ['low', 'mid', 'high']
  },
  churn: {
    type: 'noul',
    instructions: 'Is the user at churn risk?',
    threshold: 0.5
  }
};

const STATE = 'We were billed twice on the March invoice and want a refund. This is urgent.';

test('tokenizer: real tokenizer.json loads and encodes deterministically', { skip }, async () => {
  const tok = await loadTokenizer(MODEL_DIR);
  assert.equal(typeof tok, 'function');
  assert.ok(tok.mask_token_id >= 0);

  const q = { t: 'choice', ins: 'pick', crit: { a: null, b: null } };
  const a = buildSequence(tok, STATE, q, 512, 128);
  const b = buildSequence(tok, STATE, q, 512, 128);
  assert.deepEqual(Array.from(a.ids), Array.from(b.ids));
  assert.ok(a.ids.length > 20, 'sequence should not be trivially short');
});

test('tokenizer: special token ids are the model contract', { skip }, async () => {
  const tok = await loadTokenizer(MODEL_DIR);
  assert.equal(tok.cls_token_id, 2);
  assert.equal(tok.sep_token_id, 1);
  assert.equal(tok.mask_token_id, 4);
});

test('wasm backend: predict answers every question type', { skip }, async () => {
  const laya = await engineFor('wasm');
  const out = await laya.predict(STATE, QUESTIONS);
  assert.equal(out.model, 'laya-multilingual');
  assert.deepEqual(Object.keys(out.answers).sort(), ['churn', 'department', 'severity']);

  const dept = out.answers.department;
  assert.equal(dept.type, 'choice');
  assert.ok(['billing', 'tech', 'sales'].includes(dept.choice));
  assert.ok(dept.confidence >= 0 && dept.confidence <= 1);

  const sev = out.answers.severity;
  assert.equal(sev.type, 'score');
  assert.ok(sev.score >= 0 && sev.score <= 2.0, `score ${sev.score} outside [0, 2]`);

  const churn = out.answers.churn;
  assert.equal(churn.type, 'noul');
  assert.ok(churn.noul >= 0 && churn.noul <= 1);
  assert.equal(typeof churn.decision, 'boolean');
  assert.equal(churn.threshold, 0.5);
  assert.ok(out.usage.input_tokens > 0);
});

test('wasm backend: identical input produces identical answers (determinism)', { skip }, async () => {
  const laya = await engineFor('wasm');
  const a = await laya.predict(STATE, QUESTIONS);
  const b = await laya.predict(STATE, QUESTIONS);
  assert.deepEqual(a.answers, b.answers, 'same state+questions must give the same answers');
});

test('wasm backend: semantically opposite states give different answers', { skip }, async () => {
  const laya = await engineFor('wasm');
  const billing = await laya.predict(
    'I was charged twice on my invoice and need a refund please.',
    { department: QUESTIONS.department }
  );
  const tech = await laya.predict(
    'The application crashes with a segfault whenever I open the settings page.',
    { department: QUESTIONS.department }
  );
  assert.equal(billing.answers.department.choice, 'billing');
  assert.equal(tech.answers.department.choice, 'tech');
});

test('multilingual: Portuguese and Spanish billing complaints classify as billing', { skip }, async () => {
  const laya = await engineFor('wasm');
  const pt = await laya.predict('Fui cobrado em duplicidade na minha fatura e quero reembolso.', {
    department: QUESTIONS.department
  });
  const es = await laya.predict('Me cobraron dos veces en mi factura y quiero un reembolso.', {
    department: QUESTIONS.department
  });
  assert.equal(pt.answers.department.choice, 'billing');
  assert.equal(es.answers.department.choice, 'billing');
});

test('long input is truncated, never crashes (100k+ chars)', { skip }, async () => {
  const laya = await engineFor('wasm');
  const long = 'This is a very long support message. '.repeat(3000);
  const out = await laya.predict(long, { q: { type: 'noul', instructions: 'urgent?' } });
  assert.ok(Number.isFinite(out.answers.q.noul));
  assert.ok(out.usage.input_tokens > 1000, 'the truncated sequence is still large');
});

test('question type ids are stable (wire contract)', { skip }, async () => {
  assert.equal(QTYPES.choice, 0);
  assert.equal(QTYPES.score, 1);
  assert.equal(QTYPES.noul, 2);
});

test('native backend: binary serves predictions through the same API', { skip: nativeSkip }, async () => {
  const laya = await engineFor('native');
  const out = await laya.predict(STATE, QUESTIONS);
  assert.deepEqual(Object.keys(out.answers).sort(), ['churn', 'department', 'severity']);
  assert.ok(out.usage.input_tokens > 0);
});

test('native backend: agrees with wasm on the department decision', { skip: nativeSkip }, async () => {
  const native = await engineFor('native');
  const wasm = await engineFor('wasm');
  const a = await native.predict(STATE, { department: QUESTIONS.department });
  const b = await wasm.predict(STATE, { department: QUESTIONS.department });
  assert.equal(a.answers.department.choice, b.answers.department.choice);
});

test('wasm padding is semantics-preserving (pad size must not change the answer)', { skip }, async () => {
  // The wasm backend pads to a fixed shape and masks the padding out. If the
  // masking were wrong, padding to 256 vs 1024 would give different answers.
  // This isolates the padding contract from the INT8 numerics differences
  // between the two inference engines (tested separately below).
  // a decisive prompt: this test is about the padding, not about INT8 noise
  const prompt = 'We were billed twice on the March invoice and want a refund.';
  const q = { department: QUESTIONS.department };
  process.env.LAYA_WASM_PAD = '256';
  const small = await Laya.load({ modelDir: MODEL_DIR, backend: 'wasm', wasmWorkers: 1 });
  const a = await small.predict(prompt, q);
  await small.close();

  process.env.LAYA_WASM_PAD = '1024';
  const big = await Laya.load({ modelDir: MODEL_DIR, backend: 'wasm', wasmWorkers: 1 });
  const b = await big.predict(prompt, q);
  await big.close();
  delete process.env.LAYA_WASM_PAD;

  const da = a.answers.department;
  const db = b.answers.department;
  assert.equal(da.choice, db.choice, 'padding must not change the decision');
  for (const key of Object.keys(da.probabilities)) {
    const diff = Math.abs(da.probabilities[key] - (db.probabilities[key] ?? 0));
    assert.ok(diff < 0.2, `padding changed the distribution by ${diff.toFixed(4)} on '${key}'`);
  }
});

test('native and wasm agree on decisive inputs (INT8 numerics tolerance)', { skip: nativeSkip }, async () => {
  // Two different inference engines (ONNX Runtime vs tract) over INT8
  // weights are never bit-identical: on a near-tie the ranking can flip.
  // The contract is that they agree whenever the answer is actually
  // decidable, so only prompts the model finds clear are compared.
  const native = await engineFor('native');
  const wasm = await engineFor('wasm');
  const prompts = [
    'We were billed twice on the March invoice and want a refund.',
    'The application crashes with a segfault whenever I open settings.',
    'Fui cobrado em duplicidade na minha fatura e quero reembolso.',
    'Your service has been down for six hours and nobody answers.',
    'Do you support SSO with SAML for our organization?'
  ];
  let compared = 0;
  for (const text of prompts) {
    const a = await native.predict(text, { department: QUESTIONS.department });
    const b = await wasm.predict(text, { department: QUESTIONS.department });
    const da = a.answers.department;
    const db = b.answers.department;
    if (da.confidence < 0.6) continue; // near-tie: INT8 numerics may flip it
    compared++;
    assert.equal(da.choice, db.choice, `label mismatch for: ${text}`);
    for (const key of Object.keys(da.probabilities)) {
      const diff = Math.abs(da.probabilities[key] - (db.probabilities[key] ?? 0));
      assert.ok(diff <= 0.12, `probability drift ${diff.toFixed(4)} on '${key}' for: ${text}`);
    }
  }
  assert.ok(compared >= 2, `not enough decisive prompts were compared (${compared})`);
});

test('native and wasm agree on input token counts (same tokenizer)', { skip: nativeSkip }, async () => {
  const native = await engineFor('native');
  const wasm = await engineFor('wasm');
  const a = await native.predict(STATE, QUESTIONS);
  const b = await wasm.predict(STATE, QUESTIONS);
  assert.equal(a.usage.input_tokens, b.usage.input_tokens,
    'both backends must tokenize identically (pure-JS BPE == native tokenizer)');
});
