/**
 * CLI end-to-end (requires models/model.onnx for the server tests).
 * Verifies the "it just runs" experience: flags, boot banner, HTTP
 * endpoints and — critically — clean shutdown on SIGTERM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { request } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const HAS_MODEL = fs.existsSync(path.join(ROOT, 'models', 'model.onnx'));
const skip = HAS_MODEL ? false : 'models/model.onnx not present';

function runCli(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli did not exit within ${timeoutMs}ms\nstdout: ${out}\nstderr: ${err}`));
    }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('cli --version prints the package version', async () => {
  const { code, out } = await runCli(['--version']);
  assert.equal(code, 0);
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test('cli --help documents the real backends and endpoints', async () => {
  const { code, out } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(out, /native/);
  assert.match(out, /\/v1\/systemone/);
  assert.match(out, /--api-key/);
});

test('cli starts, serves requests and shuts down cleanly on SIGTERM', { skip }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  // registered up-front: if the CLI dies early we must not report a
  // misleading "did not exit after SIGTERM" timeout.
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  try {
    // wait for readiness (model load can take a while)
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !/server active and ready/i.test(out)) {
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode !== null) {
        throw new Error(`cli exited early with code ${child.exitCode}\nstdout: ${out}\nstderr: ${err}`);
      }
    }
    assert.match(out, /server active and ready/i, `cli never reported readiness\n${out}\n${err}`);

    const url = `http://127.0.0.1:${port}`;
    const health = await request(url, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json().status, 'ok');

    const evalRes = await request(url, '/v1/systemone', {
      method: 'POST',
      body: {
        state: 'We were billed twice on the March invoice.',
        questions: {
          department: {
            type: 'choice',
            instructions: 'Which department?',
            criteria: { billing: 'refunds', tech: 'bugs' }
          }
        }
      }
    });
    assert.equal(evalRes.status, 200);
    assert.equal(evalRes.json().answers.department.choice, 'billing');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r('timeout'), 15000))
    ]);
    assert.notEqual(result, 'timeout', `cli did not exit after SIGTERM\nstdout: ${out}\nstderr: ${err}`);
    // Windows cannot deliver real POSIX signals (kill() terminates the
    // process), so the exit code contract is only assertable on POSIX.
    if (process.platform !== 'win32') {
      assert.equal(result.code, 0, `cli exited with ${result.code} after SIGTERM\n${out}\n${err}`);
    }
  }
});
