# Laya System-One

**System 1 decision engine** — a multilingual INT8 transformer that answers typed questions (choice / score / yes-no) about any text, in milliseconds, offline.

Wire-compatible with the **TypeSafe Jev** `/v1/systemone` protocol: send state + typed questions, get structured decisions back.

```bash
npm install laya-system-one
```

```js
import { Laya } from 'laya-system-one';

const laya = await Laya.load();          // model is acquired on first use (once)
const out = await laya.predict(
  'We were billed twice on the March invoice and want a refund.',
  {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this?',
      criteria: { billing: 'refunds and invoices', tech: 'bugs', sales: 'upgrades' }
    },
    churn:     { type: 'noul',  instructions: 'Is the user at churn risk?', threshold: 0.5 },
    severity:  { type: 'score', instructions: 'Urgency?', criteria: ['low', 'mid', 'high'] }
  }
);

console.log(out.answers.department.choice); // → "billing"
```

Or run it as a service:

```bash
npx laya-system-one --port 8080
curl -X POST http://localhost:8080/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{"state":"I was charged twice and need a refund.","questions":{"dept":{"type":"choice","instructions":"Which department?","criteria":{"billing":"refunds","tech":"bugs"}}}}'
```

---

## What it actually is

A single ONNX checkpoint (`model.onnx`, ~324 MB, INT8) trained to score answer options for three question types, plus a small runtime that:

1. renders the state and the question options into a prompt,
2. runs one forward pass,
3. turns the logits into calibrated probabilities.

The runtime is JavaScript (Node/Bun/browser) and executes that forward pass in exactly two ways — pick one with `--backend` or `LAYA_BACKEND`:

| backend | what it is | when to use |
|---|---|---|
| `native` **(default)** | the `laya-serve` binary bundled in the package (Rust: Axum + tokenizers + ONNX Runtime, statically linked) | fastest path, zero system dependencies, any OS |
| `wasm` | pure-Rust `tract` compiled to WASM, bundled in the package | browsers and extreme portability |

There are **no external runtime dependencies**: no `onnxruntime-*`, no `@huggingface/transformers`, nothing to download besides the model. The tokenizer itself is a pure-JS BPE implementation (`src/bpe-tokenizer.js`) verified token-for-token against the reference `tokenizers` crate that the native binary links — so both backends see exactly the same input ids.

> **Note on WebGPU:** earlier versions advertised WebGPU acceleration. Measured reality: ONNX Runtime's Node WebGPU execution provider falls back to CPU per-op with large overhead — it is consistently *slower* than the native backend. WebGPU is not used server-side.

---

## The model asset

`model.onnx` is **~324 MB**, which is over the npm registry payload limit (~200 MB, HTTP 413). It therefore ships separately and is acquired automatically, in this order:

1. `LAYA_MODEL_PATH` — explicit path to a `model.onnx` (file or directory);
2. a `model.onnx` already present in the package's `models/` directory;
3. `~/.cache/laya-system-one/model.onnx` — previously acquired copy;
4. **model chunk packages on npm** — the checkpoint is split into 13 packages (`laya-system-one-model-chunk-00` … `-12`, ~24 MB each) that are reassembled locally;
5. the GitHub Release asset (fallback).

Every copy is verified against `models/model.manifest.json` (sha256 of the model *and* of each chunk) and written atomically: a killed download can never leave a corrupt model behind — the next run just retries.

Nothing else is downloaded at install time. The native binary, the tokenizer and the config ship inside the package.

### Offline / air-gapped installs

```bash
LAYA_PREFETCH_MODEL=1 npm install laya-system-one   # fetch during install
# or point at a model you already have:
LAYA_MODEL_PATH=/opt/models/model.onnx
# or drop chunk files somewhere and point at them:
LAYA_MODEL_CHUNKS_DIR=/opt/models/chunks
```

---

## API

### `Laya.load(options)` → `laya`

| option | default | description |
|---|---|---|
| `backend` | `'native'` | `native` \| `wasm` (or env `LAYA_BACKEND`) |
| `modelDir` | `<package>/models` | where `model.onnx` and `tokenizer.json` live |
| `apiKey` | `null` | Bearer token required by the HTTP layer |
| `port` / `host` | `0` / `127.0.0.1` | where the native server binds |

### `laya.predict(state, questions, model?)` → `Promise<Answer>`

`state` is a string, object or array (serialized as JSON). `questions` is a map of question definitions:

| type | `criteria` | answer |
|---|---|---|
| `choice` | object (label → meaning) or array | `{ type: 'choice', choice, probabilities, confidence }` |
| `score` | array of ordered levels | `{ type: 'score', score, legend, probabilities, confidence }` |
| `noul` | optional `{false, true}` text | `{ type: 'noul', noul, confidence, threshold?, decision? }` |

`noul` returns `noul` ∈ [0,1] (probability of *true*). With a `threshold`, a boolean `decision` is added. All fields round to 4 decimals.

### HTTP server

```js
import { serve } from 'laya-system-one';
const srv = await serve({ port: 8080, apiKey: process.env.LAYA_API_KEY });
console.log(srv.url);   // http://localhost:8080
await srv.close();      // releases the engine and any child process
```

| endpoint | method | body | response |
|---|---|---|---|
| `/v1/systemone` | `POST` | `{ state, questions, model? }` | `{ model, answers, usage }` |
| `/health` | `GET` | – | `{ status, model, backend, protocol }` |

Errors: `401` missing/invalid API key, `422` invalid payload, `404` unknown route, `413` body over 4 MB.

> The `native` backend runs its own internal HTTP server for the engine;
> `serve()` keeps it on a private loopback port and never exposes it.

---

## CLI

```bash
npx laya-system-one --port 8080 --backend native
```

```
--port <number>     HTTP port (default 8080, or PORT env)
--host <string>     bind address (default 0.0.0.0, or HOST env)
--backend <type>    native | wasm (default native)
--api-key <string>  require Bearer token auth
--help / --version
```

---

## Environment variables

| variable | effect |
|---|---|
| `LAYA_BACKEND` | `native` \| `wasm` |
| `LAYA_MODEL_PATH` | explicit `model.onnx` (file or directory) |
| `LAYA_MODEL_CHUNKS_DIR` | directory with chunk files / chunk packages |
| `LAYA_MODEL_URL` | override the download URL of the model asset |
| `LAYA_CACHE_DIR` | where downloaded models are cached |
| `LAYA_PREFETCH_MODEL` | `1` = fetch the model during `npm install` |
| `LAYA_SKIP_MODEL_DOWNLOAD` | `1` = never download, never hint |
| `LAYA_API_KEY` / `API_KEY` | require `Authorization: Bearer <key>` |
| `LAYA_SERVE_BIN` | explicit path to the `laya-serve` binary |

---

## Performance

Measure it on your own hardware with `npm run bench` (writes a JSON report).

Measured on a 4-core **Windows ARM64** laptop, Node 22, the bundled
`laya-serve` binary (the default backend):

| metric | `native` (default) | `wasm` (fallback) |
|---|---|---|
| init (load model) | 1.8 s | 1.8 s |
| cold question (first call, 4 questions) | 175 ms | 13 s |
| warm, 4 questions per call | **131 ms** (p50 113, p95 288) | 24 s |
| warm, 1 question per call | **51 ms** (p50 48, p95 71) | 6.2 s |
| sustained throughput (1 q/call) | **19.4 q/s** | 0.16 q/s |

The native binary is the product; the wasm engine is a safety net for
browsers and exotic platforms, and it is ~100x slower by design: `tract`
must specialize the whole model per input shape, so it runs a fixed padded
shape (see `LayaEngine.padForWasm`) and pays for every position.

If you are on a platform we ship a binary for and you see the wasm backend
being used, that is a bug - the install is broken (see Troubleshooting).

## Size

| component | size |
|---|---|
| npm package | ~88 MB (native binaries for 6 platforms + WASM + tokenizer) |
| model asset | ~324 MB (acquired once, cached, checksum-verified) |
| disk after install + model | ~560 MB |
| Docker (Debian slim + Bun + package) | ~450 MB image |

---

## Requirements

| | |
|---|---|
| **Node.js** | ≥ 18.17 (zero runtime dependencies) |
| **Bun** | ≥ 1.0 (fully supported) |
| **Browsers** | WASM backend (no install required) |
| **OS** | Linux (glibc + musl/Alpine), macOS (arm64), Windows (x64 + arm64) |
| **Docker** | works on Debian slim, Ubuntu, Alpine |

The `native` backend needs nothing installed: the binary is statically linked and ships in the package (for musl/Alpine it ships as a single self-extracting bundle with its own `lib/`).

---

## Storage

| what | where | size |
|---|---|---|
| package (code + binaries) | `node_modules/laya-system-one` | ~88 MB unpacked |
| model asset | `models/model.onnx` or `~/.cache/laya-system-one/` | ~324 MB |
| chunk packages | `dist/model-chunks/` (release artifacts) | ~324 MB |

The model is written to the package directory when it is writable, otherwise to the user cache — so global installs (`npm i -g`) and read-only containers work out of the box.

---

## Development

```bash
npm install
npm test                 # unit + packaging (fast, offline)
npm run test:integration # real model + tokenizer
npm run test:e2e         # HTTP protocol + CLI + lifecycle
npm run test:install     # pack + install into a clean dir + run
npm run smoke            # one-shot human-readable verification
npm run lint             # syntax + packaging + docs consistency gate
npm run tokenizer:diff   # prove the JS tokenizer == the native binary's
```

The model-distribution pipeline (the reason the 324 MB asset can live on npm):

```bash
npm run model:chunks      # split models/model.onnx into chunk packages
npm run model:assemble    # reassemble from the chunks (byte-identical)
npm run model:verify      # checksum the model against the manifest
npm run model:publish     # publish the chunk packages to npm
```

CI runs the whole matrix (OS × Node) plus model-backed integration tests on every push — see `.github/workflows/ci.yml`.

## Migrating from 1.0.0

1.0.0 on npm was a different codebase (ONNX Runtime only, model embedded, single language). The `/v1/systemone` wire protocol is unchanged, so HTTP clients keep working. Node API changes:

- `predict(state, questions)` takes a *map* of questions (1.0.0 took a single question and returned a bare value);
- `server.js`/`client.js` were replaced by `serve()` + `Laya.load()`;
- the model is no longer embedded in the package — it is acquired on first use (see above).

## License

Apache-2.0 — see [LICENSE](LICENSE).
