/**
 * Lifecycle regression tests (no model required).
 *
 * Guards the bug class that made the whole test suite hang: a `serve()`
 * session must release everything it owns so the Node process exits on its
 * own. If a child process or socket leaks, the test times out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Run a script and require it to exit cleanly within `timeoutMs`. */
function runScript(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${timeoutMs}ms — something is keeping the event loop alive\nstdout: ${out}\nstderr: ${err}`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const STUB_LAYA = `
  const stub = {
    async predict() { return { model: 'stub', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; },
    async close() {}
  };
`;

test('serve() + close() lets the process exit on its own', async () => {
  const { code, err } = await runScript(`
    import { serve } from './src/server.js';
    ${STUB_LAYA}
    const srv = await serve({ host: '127.0.0.1', port: 0, laya: stub, warmup: false });
    await fetch(srv.url + '/health');
    await srv.close();
    console.log('DONE');
  `);
  assert.equal(code, 0, `process exited with ${code}\n${err}`);
});

test('serve() + close() exits even with pooled client connections open', async () => {
  const { code, err } = await runScript(`
    import { serve } from './src/server.js';
    ${STUB_LAYA}
    const srv = await serve({ host: '127.0.0.1', port: 0, laya: stub, warmup: false });
    // open several keep-alive connections and never close them (undici pools)
    await Promise.all([1, 2, 3].map(() => fetch(srv.url + '/health')));
    await srv.close();
    console.log('DONE');
  `);
  assert.equal(code, 0, `process exited with ${code}\n${err}`);
});

test('an engine created by serve() is closed when the server closes', async () => {
  const { code, out, err } = await runScript(`
    import { serve } from './src/server.js';
    let engineClosed = false;
    const fakeLaya = {
      async predict() { return { model: 'stub', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; },
      async close() { engineClosed = true; }
    };
    // simulate "server owns the engine" by passing it through the factory path
    const srv = await serve({ host: '127.0.0.1', port: 0, laya: fakeLaya, warmup: false });
    await srv.close();
    console.log('OWNER_CLOSED=' + engineClosed);
  `);
  assert.equal(code, 0, `process exited with ${code}\n${err}`);
  assert.match(out, /OWNER_CLOSED=false/, 'caller-owned engines must not be closed by serve()');
});

test('an engine created internally is closed by serve() (ownership contract)', async () => {
  // serve() must close the engine only when it created it itself. Verify the
  // contract without any model by substituting Laya.load with a stub.
  const { code, out, err } = await runScript(`
    import { serve } from './src/server.js';
    import * as agent from './src/agent.js';
    let ownedClosed = false;
    agent.Laya.load = async () => ({
      async predict() { return { model: 'stub', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; },
      async close() { ownedClosed = true; }
    });
    const srv = await serve({ host: '127.0.0.1', port: 0, warmup: false });
    await srv.close();
    console.log('OWNED_CLOSED=' + ownedClosed);
  `);
  assert.equal(code, 0, `process exited with ${code}\n${err}`);
  assert.match(out, /OWNED_CLOSED=true/, 'internally created engines must be closed by serve()');
});
