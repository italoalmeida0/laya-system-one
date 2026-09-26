/**
 * End-to-end: the full TypeSafe Jev wire contract over real HTTP with the
 * real model (skipped when models/model.onnx is absent).
 *
 * This is the regression net for the bug class that matters most: the
 * server must answer correctly AND shut down cleanly (a leaked laya-serve
 * child process used to keep the Node process alive forever).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Laya } from '../../src/agent.js';
import { serve } from '../../src/server.js';
import { request, E2E_BACKEND, NATIVE_SKIP } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_DIR = path.join(ROOT, 'models');
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, 'model.onnx'));
const skip = HAS_MODEL ? false : 'models/model.onnx not present';

const VALID_BODY = {
  state: 'We were billed twice on the March invoice.',
  model: 'jev-1.13.0',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this?',
      criteria: {
        billing: 'refunds and invoices',
        tech: 'bugs',
        sales: 'upgrades and contracts'
      }
    },
    severity: {
      type: 'score',
      instructions: 'Urgency level?',
      criteria: ['low', 'medium', 'high']
    },
    churn: {
      type: 'noul',
      instructions: 'Is the user at risk of churning?',
      threshold: 0.5
    },
    refund: {
      type: 'noul',
      instructions: 'Is a refund explicitly requested?'
    }
  }
};

const post = (url, body, headers = {}) => request(url, '/v1/systemone', {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers
});

test('GET /health answers with the TypeSafe Jev protocol marker', { skip }, async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const res = await request(srv.url, '/health');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.protocol, 'TypeSafe Jev /v1/systemone compatible');
  } finally {
    await srv.close();
  }
});

test('POST /v1/systemone returns a schema-compliant evaluation', { skip }, async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const res = await post(srv.url, VALID_BODY);
    assert.equal(res.status, 200);
    const body = res.json();

    assert.equal(body.model, VALID_BODY.model, 'the requested model name is echoed back');
    assert.deepEqual(
      Object.keys(body.answers).sort(),
      ['churn', 'department', 'refund', 'severity']
    );

    const dept = body.answers.department;
    assert.equal(dept.type, 'choice');
    assert.ok(['billing', 'tech', 'sales'].includes(dept.choice));
    for (const p of Object.values(dept.probabilities)) {
      assert.ok(p >= 0 && p <= 1);
    }

    const sev = body.answers.severity;
    assert.equal(sev.type, 'score');
    assert.ok(sev.score >= 0 && sev.score <= 2);
    assert.deepEqual(Object.keys(sev.legend).sort(), ['0', '1', '2']);

    for (const key of ['churn', 'refund']) {
      const a = body.answers[key];
      assert.equal(a.type, 'noul');
      assert.ok(a.noul >= 0 && a.noul <= 1);
      assert.ok(a.confidence >= 0 && a.confidence <= 1);
    }
    assert.equal(typeof body.answers.churn.decision, 'boolean', 'a threshold yields a boolean decision');
    assert.equal(body.answers.churn.threshold, 0.5);
    assert.equal('decision' in body.answers.refund, false, 'no threshold -> no decision field');

    assert.ok(body.usage.input_tokens > 0);
    assert.ok(body.usage.output_tokens > 0);
  } finally {
    await srv.close();
  }
});

test('billing complaints are routed to billing (pt/en/es)', { skip }, async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const prompts = {
      en: 'I was charged twice on my invoice and would like a refund.',
      pt: 'Fui cobrado em duplicidade na minha fatura e quero reembolso.',
      es: 'Me cobraron dos veces en mi factura y quiero un reembolso.'
    };
    for (const [lang, text] of Object.entries(prompts)) {
      const res = await post(srv.url, {
        state: text,
        questions: { department: VALID_BODY.questions.department }
      });
      assert.equal(res.status, 200);
      assert.equal(res.json().answers.department.choice, 'billing', `${lang} prompt misrouted`);
    }
  } finally {
    await srv.close();
  }
});

test('api-key enforcement over the wire', { skip }, async () => {
  const srv = await serve({
    host: '127.0.0.1', port: 0, modelDir: MODEL_DIR,
    backend: E2E_BACKEND, apiKey: 'test-secret'
  });
  try {
    assert.equal((await post(srv.url, VALID_BODY)).status, 401);
    assert.equal((await post(srv.url, VALID_BODY, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(srv.url, VALID_BODY, { Authorization: 'Bearer test-secret' })).status, 200);
  } finally {
    await srv.close();
  }
});

test('malformed payloads are rejected with 422', { skip }, async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const bad = await post(srv.url, '{"state": "test", "questions": {}}');
    assert.equal(bad.status, 200, 'empty questions is valid');

    assert.equal((await post(srv.url, '{invalid json')).status, 422);
    assert.equal((await post(srv.url, { questions: {} })).status, 422);
    assert.equal((await post(srv.url, { state: 'x', questions: 42 })).status, 422);
    assert.equal((await post(srv.url, { state: 'x', questions: { q: { type: 'ranking' } } })).status, 422);
  } finally {
    await srv.close();
  }
});

test('unknown endpoints return 404', { skip }, async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const res = await request(srv.url, '/nope');
    assert.equal(res.status, 404);
    assert.match(res.json().error, /\/v1\/systemone/);
  } finally {
    await srv.close();
  }
});

test('the engine can be reused across many evaluations', { skip }, async () => {
  const laya = await Laya.load({ modelDir: MODEL_DIR, backend: E2E_BACKEND });
  try {
    const srv = await serve({ host: '127.0.0.1', port: 0, laya, warmup: false });
    try {
      for (let i = 0; i < 25; i++) {
        const res = await post(srv.url, VALID_BODY);
        assert.equal(res.status, 200, `request ${i} failed`);
      }
    } finally {
      await srv.close();
    }
  } finally {
    await laya.close();
  }
});
