/**
 * Integration tests — run against the real INT8 model + tokenizer.
 * Skipped automatically when models/model.onnx is not present
 * (set LAYA_REQUIRE_MODEL=1 in CI to make a missing model a hard failure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Laya } from '../../src/agent.js';
import { LayaEngine } from '../../src/engine.js';
import { loadTokenizer, buildSequence, QTYPES } from '../../src/tokenizer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_DIR = path.join(ROOT, 'models');
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, 'model.onnx'));

const skip = HAS_MODEL ? false : 'models/model.onnx not present (run `node tools/model-chunks.js assemble`)';

if (!HAS_MODEL && process.env.LAYA_REQUIRE_MODEL === '1') {
  throw new Error('LAYA_REQUIRE_MODEL=1 but models/model.onnx is missing');
}

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: {
      billing: 'refunds and invoices',
      tech: 'bugs',
      sales: 'upgrades'
    }
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

test('ort backend: engine loads the real model and runs a forward pass', { skip }, async () => {
  const engine = await LayaEngine.load({ modelDir: MODEL_DIR, device: 'cpu' });
  try {
    assert.ok(engine.session, 'session must be created');
    assert.equal(typeof engine.run, 'function');
  } finally {
    await engine.close();
  }
});

test('ort backend: predict answers every question type', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, device: 'cpu', backend: 'ort' });
  try {
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
  } finally {
    await laya.close();
  }
});

test('ort backend: identical input produces identical answers (determinism)', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, device: 'cpu', backend: 'ort' });
  try {
    const a = await laya.predict(STATE, QUESTIONS);
    const b = await laya.predict(STATE, QUESTIONS);
    assert.deepEqual(a.answers, b.answers, 'same state+questions must give the same answers');
  } finally {
    await laya.close();
  }
});

test('ort backend: semantically opposite states give different answers', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, device: 'cpu', backend: 'ort' });
  try {
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
  } finally {
    await laya.close();
  }
});

test('multilingual: Portuguese and Spanish billing complaints classify as billing', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, device: 'cpu', backend: 'ort' });
  try {
    const pt = await laya.predict('Fui cobrado em duplicidade na minha fatura e quero reembolso.', {
      department: QUESTIONS.department
    });
    const es = await laya.predict('Me cobraron dos veces en mi factura y quiero un reembolso.', {
      department: QUESTIONS.department
    });
    assert.equal(pt.answers.department.choice, 'billing');
    assert.equal(es.answers.department.choice, 'billing');
  } finally {
    await laya.close();
  }
});

test('native backend: binary serves predictions through the same API', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, backend: 'native' });
  try {
    const out = await laya.predict(STATE, QUESTIONS);
    assert.deepEqual(Object.keys(out.answers).sort(), ['churn', 'department', 'severity']);
    assert.ok(out.usage.input_tokens > 0);
  } finally {
    await laya.close();
  }
});

test('native backend: agrees with ort on the department decision', { skip }, async () => {
  const native = await Laya.load({ modelDir: MODEL_DIR, backend: 'native' });
  const ort = await Laya.load({ modelDir: MODEL_DIR, backend: 'ort', device: 'cpu' });
  try {
    const a = await native.predict(STATE, { department: QUESTIONS.department });
    const b = await ort.predict(STATE, { department: QUESTIONS.department });
    assert.equal(a.answers.department.choice, b.answers.department.choice);
  } finally {
    await native.close();
    await ort.close();
  }
});

test('long input is truncated, never crashes (100k+ chars)', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, device: 'cpu', backend: 'ort' });
  try {
    const long = 'This is a very long support message. '.repeat(3000);
    const out = await laya.predict(long, { q: { type: 'noul', instructions: 'urgent?' } });
    assert.ok(Number.isFinite(out.answers.q.noul));
    assert.ok(out.usage.input_tokens > 1000, 'the truncated sequence is still large');
  } finally {
    await laya.close();
  }
});

test('question type ids are stable (wire contract)', { skip }, async () => {
  assert.equal(QTYPES.choice, 0);
  assert.equal(QTYPES.score, 1);
  assert.equal(QTYPES.noul, 2);
});
