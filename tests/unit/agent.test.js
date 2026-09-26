/**
 * Unit tests for the decision math (src/agent.js).
 * These are the highest-value tests in the repo: the answer decoder is the
 * part that must never silently change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { softmax, confidenceFromProbs, buildAnswer, validateQuestionDef, validateQuestions, Laya, LayaNative } from '../../src/agent.js';
import { fakeTokenizer, mockEngine } from '../helpers/index.js';

const CONFIG = { temperature: [1.0, 1.0, 1.0] };

test('softmax: sums to 1 and prefers the largest logit', () => {
  const p = softmax([0, 0, 9]);
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(p[2] > 0.99);
});

test('softmax: temperature scales the distribution', () => {
  const sharp = softmax([1, 2], 0.5);
  const flat = softmax([1, 2], 100);
  assert.ok(sharp[1] > flat[1], 'lower temperature must sharpen');
  // temperature 0 is clamped, never NaN/Infinity
  const zero = softmax([1, 2], 0);
  assert.ok(Number.isFinite(zero[0]) && Number.isFinite(zero[1]));
});

test('confidence: uniform distribution -> 0, one-hot -> 1', () => {
  const uniform = confidenceFromProbs([0.25, 0.25, 0.25, 0.25], 4);
  const oneHot = confidenceFromProbs([1, 0, 0, 0], 4);
  assert.ok(Math.abs(uniform) < 1e-12);
  assert.ok(Math.abs(oneHot - 1) < 1e-12);
});

test('confidence: single option is always 1.0 and stays in [0, 1]', () => {
  assert.equal(confidenceFromProbs([1], 1), 1.0);
  for (const probs of [[0.9, 0.1], [0.5, 0.5], [0.01, 0.99]]) {
    const c = confidenceFromProbs(probs, 2);
    assert.ok(c >= 0 && c <= 1, `confidence out of range: ${c}`);
  }
});

test('choice: picks the highest-probability criterion and reports probabilities', () => {
  const item = {
    q: { t: 'choice', crit: { billing: 'a', tech: 'b', sales: 'c' } },
    qdef: { type: 'choice' },
    qtype: 0,
    markers: [0, 1, 2],
    logits: [1.0, 5.0, 2.0]
  };
  const ans = buildAnswer(item, CONFIG);
  assert.equal(ans.type, 'choice');
  assert.equal(ans.choice, 'tech');
  assert.deepEqual(Object.keys(ans.probabilities).sort(), ['billing', 'sales', 'tech']);
  const sum = Object.values(ans.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-3);
  assert.ok(ans.confidence > 0 && ans.confidence <= 1);
});

test('choice: ties resolve to the first criterion (deterministic)', () => {
  const item = {
    q: { t: 'choice', crit: { first: null, second: null } },
    qdef: {},
    qtype: 0,
    markers: [0, 1],
    logits: [3, 3]
  };
  assert.equal(buildAnswer(item, CONFIG).choice, 'first');
});

test('score: expected value is the probability-weighted level', () => {
  const item = {
    q: { t: 'score', crit: ['low', 'mid', 'high'] },
    qdef: { type: 'score' },
    qtype: 1,
    markers: [0, 1, 2],
    logits: [0, 0, 0] // uniform -> expected 1.0
  };
  const ans = buildAnswer(item, CONFIG);
  assert.equal(ans.type, 'score');
  assert.ok(Math.abs(ans.score - 1.0) < 1e-3);
  assert.deepEqual(ans.legend, { 0: 'low', 1: 'mid', 2: 'high' });
});

test('score: extreme logits land on the matching level', () => {
  const low = buildAnswer({ q: { t: 'score', crit: ['a', 'b', 'c'] }, qdef: {}, qtype: 1, markers: [0, 1, 2], logits: [10, 0, 0] }, CONFIG);
  const high = buildAnswer({ q: { t: 'score', crit: ['a', 'b', 'c'] }, qdef: {}, qtype: 1, markers: [0, 1, 2], logits: [0, 0, 10] }, CONFIG);
  assert.ok(low.score < 0.05);
  assert.ok(high.score > 1.95, `expected near the top level (2.0), got ${high.score}`);
  assert.ok(high.score <= 2.0);
});

test('noul: reports p(true), confidence and threshold decision', () => {
  const item = {
    q: { t: 'noul', crit: {} },
    qdef: { type: 'noul', threshold: 0.5 },
    qtype: 2,
    markers: [0, 1],
    logits: [0, 2]
  };
  const ans = buildAnswer(item, CONFIG);
  assert.equal(ans.type, 'noul');
  assert.ok(ans.noul > 0.7 && ans.noul < 0.9, `p(true)=${ans.noul}`);
  assert.equal(ans.threshold, 0.5);
  assert.equal(ans.decision, true);
  assert.ok(Math.abs(ans.confidence - ans.noul) < 1e-9, 'confidence is max(p, 1-p)');
});

test('noul: below threshold -> decision false, no threshold -> no decision', () => {
  const below = buildAnswer({ q: { t: 'noul', crit: {} }, qdef: { threshold: 0.9 }, qtype: 2, markers: [0, 1], logits: [0, 2] }, CONFIG);
  assert.equal(below.decision, false);

  const bare = buildAnswer({ q: { t: 'noul', crit: {} }, qdef: {}, qtype: 2, markers: [0, 1], logits: [0, 2] }, CONFIG);
  assert.equal('decision' in bare, false);
  assert.equal('threshold' in bare, false);
});

test('noul: single-marker question never returns NaN', () => {
  const ans = buildAnswer({ q: { t: 'noul', crit: {} }, qdef: {}, qtype: 2, markers: [0], logits: [1.5] }, CONFIG);
  assert.ok(Number.isFinite(ans.noul));
  assert.ok(Number.isFinite(ans.confidence));
});

test('answers are rounded to 4 decimals (stable wire format)', () => {
  const ans = buildAnswer({ q: { t: 'choice', crit: { a: null, b: null } }, qdef: {}, qtype: 0, markers: [0, 1], logits: [0.123456789, 0.987654321] }, CONFIG);
  for (const v of Object.values(ans.probabilities)) {
    assert.equal(v, Number(v.toFixed(4)));
  }
  assert.equal(ans.confidence, Number(ans.confidence.toFixed(4)));
});

test('validateQuestionDef: the wire contract is shared by every backend', () => {
  assert.equal(validateQuestionDef('q', { type: 'choice' }), 'choice');
  assert.equal(validateQuestionDef('q', { type: 'score' }), 'score');
  assert.equal(validateQuestionDef('q', { type: 'noul' }), 'noul');
  assert.equal(validateQuestionDef('q', {}), 'choice', 'type defaults to choice');
  assert.throws(() => validateQuestionDef('q', { type: 'ranking' }), /Unsupported question type/);
  assert.throws(() => validateQuestionDef('q', 'nope'), /must be an object/);
  assert.throws(() => validateQuestionDef('q', null), /must be an object/);
});

test('validateQuestions: rejects non-object maps and unknown types', () => {
  assert.deepEqual(validateQuestions({ a: { type: 'noul' } }), ['a']);
  for (const bad of ['str', 42, ['a'], null, undefined]) {
    assert.throws(() => validateQuestions(bad), /object map/);
  }
  assert.throws(() => validateQuestions({ q: { type: 'ranking' } }), /Unsupported question type/);
});

test('LayaNative: question validation is identical to the JS engine', async () => {
  const calls = [];
  const fakeServer = {
    async predict(state, questions, model) {
      calls.push({ state, questions, model });
      return { model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    }
  };
  const laya = new LayaNative(fakeServer, {});

  await assert.rejects(() => laya.predict('x', { q: { type: 'ranking' } }), /Unsupported question type/);
  await assert.rejects(() => laya.predict('x', { q: 'nope' }), /must be an object/);
  await assert.rejects(() => laya.predict('x', 42), /object map/);
  assert.equal(calls.length, 0, 'invalid payloads must never reach the engine');
});

test('LayaNative: missing type is filled in before forwarding (binary requires it)', async () => {
  const calls = [];
  const fakeServer = {
    async predict(state, questions, model) {
      calls.push(questions);
      return { model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    }
  };
  const laya = new LayaNative(fakeServer, {});

  await laya.predict('x', { q: {}, other: { type: 'noul', threshold: 0.5 } });
  assert.deepEqual(calls[0].q, { type: 'choice' }, 'default type is choice');
  assert.deepEqual(calls[0].other, { type: 'noul', threshold: 0.5 }, 'explicit definitions pass through untouched');
});

test('LayaNative: empty questions never reach the engine', async () => {
  let called = false;
  const fakeServer = {
    async predict() { called = true; return { model: 'x', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; }
  };
  const laya = new LayaNative(fakeServer, { model: 'custom' });
  const out = await laya.predict('x', {});
  assert.equal(called, false);
  assert.deepEqual(out, { model: 'custom', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
});

/* --------------------------- Laya.predict --------------------------- */

test('Laya.predict: empty questions map returns an empty answer set', async () => {
  const laya = new Laya(mockEngine([[1]]), fakeTokenizer());
  const out = await laya.predict('hello', {});
  assert.deepEqual(out.answers, {});
  assert.equal(out.usage.input_tokens, 0);
});

test('Laya.predict: unknown question type is rejected', async () => {
  const laya = new Laya(mockEngine([[1]]), fakeTokenizer());
  await assert.rejects(
    () => laya.predict('hello', { q1: { type: 'ranking' } }),
    /Unsupported question type/
  );
});

test('Laya.predict: non-object question definition is rejected', async () => {
  const laya = new Laya(mockEngine([[1]]), fakeTokenizer());
  await assert.rejects(() => laya.predict('hello', { q1: 'oops' }), /must be an object/);
});

test('Laya.predict: returns one answer per question with the right type', async () => {
  const laya = new Laya(mockEngine([[5, 0, 0, 0, 0]]), fakeTokenizer());
  const out = await laya.predict({ text: 'hello world' }, {
    dept: {
      type: 'choice',
      instructions: 'Which department?',
      criteria: { billing: 'money', support: 'bugs' }
    },
    sev: {
      type: 'score',
      instructions: 'Severity?',
      criteria: ['low', 'high']
    },
    refund: {
      type: 'noul',
      instructions: 'Refund requested?',
      threshold: 0.5
    }
  });

  assert.deepEqual(Object.keys(out.answers).sort(), ['dept', 'refund', 'sev']);
  assert.equal(out.answers.dept.type, 'choice');
  assert.equal(out.answers.sev.type, 'score');
  assert.equal(out.answers.refund.type, 'noul');
  assert.equal(out.model, 'laya-multilingual');
  assert.ok(out.usage.input_tokens > 0);
});

test('Laya.predict: criteria array is accepted for choice questions', async () => {
  const laya = new Laya(mockEngine([[1, 2]]), fakeTokenizer());
  const out = await laya.predict('x', {
    q: { type: 'choice', instructions: 'pick', criteria: ['alpha', 'beta'] }
  });
  assert.equal(out.answers.q.choice, 'beta');
  assert.deepEqual(Object.keys(out.answers.q.probabilities).sort(), ['alpha', 'beta']);
});

test('Laya.predict: custom model name is echoed back', async () => {
  const laya = new Laya(mockEngine([[1, 2]]), fakeTokenizer());
  const out = await laya.predict('x', { q: { type: 'noul' } }, 'laya-custom-v3');
  assert.equal(out.model, 'laya-custom-v3');
});

test('Laya.predict: long state is truncated to max_len (never throws)', async () => {
  const engine = mockEngine([[1, 2]]);
  engine.config.max_len = 32;
  const laya = new Laya(engine, fakeTokenizer());
  const out = await laya.predict('lorem ipsum '.repeat(5000), {
    q: { type: 'noul', instructions: 'ok?' }
  });
  assert.ok(out.answers.q);
  const ids = engine.calls[0][0].ids;
  assert.ok(ids.length <= 32, `sequence length ${ids.length} exceeds max_len`);
});

test('Laya.predict: sequence layout is cls + head + [mask..] options + state + sep', async () => {
  const engine = mockEngine([[1, 2]]);
  const laya = new Laya(engine, fakeTokenizer());
  await laya.predict('some state', {
    q: { type: 'choice', instructions: 'pick one', criteria: { a: null, b: null } }
  });
  const item = engine.calls[0][0];
  assert.equal(item.ids[0], 2, 'starts with [CLS]');
  assert.equal(item.ids[item.ids.length - 1], 1, 'ends with [SEP]');
  assert.equal(item.markers.length, 2, 'one mask marker per option');
  for (const m of item.markers) {
    assert.equal(item.ids[m], 4, 'marker points at [MASK]');
  }
});
