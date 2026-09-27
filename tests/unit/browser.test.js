/**
 * The browser path.
 *
 * Node cannot import a module over http:, so one step of the browser flow -
 * the glue import - cannot be exercised here and is verified in a real
 * browser instead. Everything else can, and this file covers it: the
 * environment detection, the default backend, and the fact that no module on
 * the browser path reaches for `process` or a node: builtin at import time.
 *
 * The last point is the one that actually broke: a static
 * `import fs from 'node:fs'` (or a bare `process.env`) makes the package
 * unloadable in a browser even when the code path never uses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Modules a browser loads: agent + engine + tokenizer + wasm, not native. */
const BROWSER_MODULES = [
  'src/env.js',
  'src/agent.js',
  'src/engine.js',
  'src/tokenizer.js',
  'src/bpe-tokenizer.js',
  'src/laya-wasm.js',
  'src/laya-wasm-pool.js'
];

test('no module on the browser path imports a node builtin statically', () => {
  for (const rel of BROWSER_MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // strip comments: the files explain the rule and would match themselves
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const staticImports = [...code.matchAll(/^\s*import\s[^;]*from\s+['"]node:/gm)].map((m) => m[0].trim());
    assert.deepEqual(staticImports, [],
      `${rel} must import node builtins lazily (dynamic import), not at module scope`);
  }
});

test('no module on the browser path reads process at module scope', () => {
  for (const rel of BROWSER_MODULES) {
    if (rel === 'src/env.js') continue; // the one place that is allowed to
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // inside a function is fine (guarded by isBrowser); at the top level is not
    const topLevel = code.split('\n').filter((l) => /^[^ \t]/.test(l) && /\bprocess\b/.test(l));
    assert.deepEqual(topLevel, [], `${rel} must not touch process at module scope`);
  }
});

test('the browser modules load with process and window swapped', async () => {
  // A browser has window/document and no process. Importing the modules must
  // not throw, and the default backend must be wasm (native spawns a process).
  const realProcess = globalThis.process;
  globalThis.window = globalThis;
  globalThis.document = {};
  delete globalThis.process;
  try {
    const env = await import(`${pathToFileURL(path.join(ROOT, 'src/env.js')).href}?browser=1`);
    assert.equal(env.isBrowser, true);
    assert.equal(env.isNode, false);
    assert.equal(env.defaultBackend(), 'wasm', 'a browser cannot spawn the native binary');
    assert.equal(env.env('ANYTHING'), undefined, 'env() must not throw without process');

    // the engine must import without touching the filesystem
    await import(`${pathToFileURL(path.join(ROOT, 'src/engine.js')).href}?browser=1`);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    globalThis.process = realProcess;
  }
});

test('the default backend stays native on Node', async () => {
  // A distinct query string: the previous test imported env.js with the
  // browser globals in place, and ESM caches by URL, so reusing it would
  // assert against the cached browser-flavoured instance.
  const env = await import(`${pathToFileURL(path.join(ROOT, 'src/env.js')).href}?node=1`);
  assert.equal(env.isNode, true);
  assert.equal(env.isBrowser, false);
  assert.equal(env.defaultBackend(), 'native', 'Node gets the fast path');
});
