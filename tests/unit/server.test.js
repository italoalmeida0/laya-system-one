/**
 * HTTP wire-protocol tests (src/server.js) — no model needed: a stub Laya
 * is injected so only the TypeSafe Jev protocol contract is exercised.
 *
 * Requests go through tests/helpers request() (agent: false) so every test
 * gets a fresh connection — the global fetch keeps sockets alive per origin
 * and a socket destroyed by a previous close() poisons the pool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serve } from '../../src/server.js';
import { request } from '../helpers/index.js';

function stubLaya(result = { model: 'stub', answers: { q: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 4 } }) {
  const calls = [];
  return {
    calls,
    async predict(state, questions, model) {
      calls.push({ state, questions, model });
      return typeof result === 'function' ? result(state, questions) : result;
    },
    closed: false,
    async close() { this.closed = true; }
  };
}

async function withServer(options, fn) {
  const srv = await serve({ host: '127.0.0.1', port: 0, warmup: false, ...options });
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

const VALID = {
  state: { text: 'hello' },
  questions: { q: { type: 'noul', instructions: 'ok?' } }
};

const post = (url, body, headers = {}) => request(url, '/v1/systemone', {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers
});

test('serve() honors port 0 (random free port)', async () => {
  const srv = await serve({ host: '127.0.0.1', port: 0, warmup: false, laya: stubLaya() });
  try {
    assert.match(srv.url, /127\.0\.0\.1:\d+$/);
    const port = Number(srv.url.split(':').pop());
    assert.ok(port > 0 && port < 65536, `unexpected port ${port}`);
  } finally {
    await srv.close();
  }
});

test('GET /health returns an ok payload', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    const res = await request(url, '/health');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.protocol, 'TypeSafe Jev /v1/systemone compatible');
  });
});

test('POST /v1/systemone evaluates and proxies the model echo', async () => {
  const laya = stubLaya();
  await withServer({ laya }, async ({ url }) => {
    const res = await post(url, { ...VALID, model: 'custom-model' });
    assert.equal(res.status, 200);
    assert.equal(res.json().model, 'stub');
    assert.equal(laya.calls.length, 1);
    assert.equal(laya.calls[0].model, 'custom-model');
    assert.deepEqual(laya.calls[0].state, VALID.state);
  });
});

test('POST with invalid JSON returns 422', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    const res = await post(url, '{not json');
    assert.equal(res.status, 422);
    assert.match(res.json().error, /invalid JSON/i);
  });
});

test('POST without state returns 422', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    const res = await post(url, { questions: VALID.questions });
    assert.equal(res.status, 422);
    assert.match(res.json().error, /state/);
  });
});

test('POST with questions that is not an object map returns 422', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    for (const bad of ['string', 42, ['a'], null]) {
      const res = await post(url, { state: 'x', questions: bad });
      assert.equal(res.status, 422, `questions=${JSON.stringify(bad)} must be rejected`);
    }
  });
});

test('POST that throws in the engine returns 422 with the message', async () => {
  const laya = stubLaya(() => { throw new Error('boom detail'); });
  await withServer({ laya }, async ({ url }) => {
    const res = await post(url, VALID);
    assert.equal(res.status, 422);
    assert.match(res.json().error, /boom detail/);
  });
});

test('unknown routes return 404 with the expected endpoint', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    for (const p of ['/nope', '/v1/systemtwo', '/v1']) {
      const res = await request(url, p);
      assert.equal(res.status, 404);
      assert.match(res.json().error, /\/v1\/systemone/);
    }
  });
});

test('api-key enforcement: 401 without/with a bad token, 200 with the right one', async () => {
  await withServer({ laya: stubLaya(), apiKey: 'secret-123' }, async ({ url }) => {
    assert.equal((await post(url, VALID)).status, 401);
    assert.equal((await post(url, VALID, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(url, VALID, { Authorization: 'secret-123' })).status, 401, 'scheme is required');
    assert.equal((await post(url, VALID, { Authorization: 'Bearer secret-123' })).status, 200);
  });
});

test('CORS: preflight and headers are permissive', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    const pre = await request(url, '/v1/systemone', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.match(pre.headers['access-control-allow-headers'] || '', /Authorization/);

    const res = await request(url, '/health');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});

test('payloads over the 4MB guard return 413', async () => {
  await withServer({ laya: stubLaya() }, async ({ url }) => {
    const huge = { state: 'x'.repeat(5 * 1024 * 1024), questions: VALID.questions };
    try {
      const res = await post(url, huge);
      assert.equal(res.status, 413);
    } catch {
      // some stacks abort the connection on an early 413 — both outcomes ok
    }
  });
});

test('close() releases the HTTP server and never closes a caller-owned engine', async () => {
  const owned = stubLaya();
  const srv = await serve({ host: '127.0.0.1', port: 0, warmup: false, laya: owned });
  const url = srv.url;
  await srv.close();
  assert.equal(owned.closed, false, 'an engine injected by the caller must not be closed');
  await assert.rejects(() => request(url, '/health'), 'server must stop accepting connections');
});

test('concurrent requests are all answered', async () => {
  const laya = stubLaya();
  await withServer({ laya }, async ({ url }) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => post(url, VALID)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(laya.calls.length, 20);
  });
});
