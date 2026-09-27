# Laya System-One

**A decision engine in one package.** Give it any text and a set of typed
questions, and it answers them — which category, how urgent, yes or no — in
milliseconds, offline, in any language.

```bash
npm install laya-system-one
```

```js
import { Laya } from 'laya-system-one';

const laya = await Laya.load();

const out = await laya.predict(
  'We were billed twice on the March invoice and want a refund.',
  {
    department: {
      type: 'choice',
      instructions: 'Which department should handle this?',
      criteria: { billing: 'refunds and invoices', tech: 'bugs', sales: 'upgrades' }
    },
    churn:    { type: 'noul',  instructions: 'Is the user at churn risk?', threshold: 0.5 },
    severity: { type: 'score', instructions: 'How urgent is this?', criteria: ['low', 'mid', 'high'] }
  }
);

console.log(out.answers.department.choice); // → "billing"
console.log(out.answers.churn.noul);        // → 0.87
```

That is the whole API. No accounts, no API keys, no internet at inference
time. The first run downloads the model once (~324 MB) and caches it.

## Run it as a service

```bash
npx laya-system-one --port 8080
```

```bash
curl -X POST http://localhost:8080/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "state": "I was charged twice and need a refund.",
    "questions": {
      "dept": { "type": "choice", "instructions": "Which department?",
                "criteria": { "billing": "refunds", "tech": "bugs" } }
    }
  }'
```

The `/v1/systemone` wire format is compatible with the TypeSafe Jev protocol:
send a state plus typed questions, get structured decisions back.

## Backends

| backend | how it runs | when to pick it |
|---|---|---|
| `native` **(default)** | a self-contained Rust server bundled with the package | the normal choice — fastest, nothing to install |
| `wasm` | pure Rust compiled to WebAssembly, also bundled | browsers, or platforms with no native build |

Both are inside the package; nothing is compiled or fetched at install time.
Switch with `--backend wasm` or `LAYA_BACKEND=wasm`.

## API

### `Laya.load(options)` → `Promise<Laya>`

| option | default | description |
|---|---|---|
| `backend` | `'native'` | `native` or `wasm` |
| `modelDir` | the package's `models/` | where `model.onnx` and `tokenizer.json` live |
| `apiKey` | `null` | require a Bearer token on the HTTP layer |
| `port` / `host` | `0` / `127.0.0.1` | where the native server binds |

### `laya.predict(state, questions)` → `Promise<Answer>`

`state` is a string, object or array (serialized as JSON). `questions` is a map
of question definitions:

| type | `criteria` | answer |
|---|---|---|
| `choice` | object (label → meaning) or array | `{ type, choice, probabilities, confidence }` |
| `score` | array of ordered levels | `{ type, score, legend, probabilities, confidence }` |
| `noul` | optional `{ false, true }` text | `{ type, noul, confidence, threshold?, decision? }` |

`noul` returns the probability of *true*; add a `threshold` to also get a
boolean `decision`. All numbers round to 4 decimals.

### `serve(options)` → `Promise<Server>`

```js
import { serve } from 'laya-system-one';

const srv = await serve({ port: 8080, apiKey: process.env.LAYA_API_KEY });
console.log(srv.url);
await srv.close();
```

| endpoint | method | body | response |
|---|---|---|---|
| `/v1/systemone` | `POST` | `{ state, questions, model? }` | `{ model, answers, usage }` |
| `/health` | `GET` | – | `{ status, model, backend, protocol }` |

Errors: `401` bad API key, `422` invalid payload, `404` unknown route,
`413` body over 4 MB.

## CLI

```bash
npx laya-system-one --port 8080 --backend native
```

```
--port <number>     HTTP port (default 8080, or PORT)
--host <string>     bind address (default 0.0.0.0, or HOST)
--backend <type>    native | wasm (default native)
--api-key <string>  require Bearer token auth
--help / --version
```

## Environment variables

| variable | effect |
|---|---|
| `LAYA_BACKEND` | `native` or `wasm` |
| `LAYA_MODEL_PATH` | use a `model.onnx` you already have (file or directory) |
| `LAYA_MODEL_CHUNKS_DIR` | directory holding the model chunks |
| `LAYA_MODEL_URL` | override where the model is downloaded from |
| `LAYA_CACHE_DIR` | where the model is cached |
| `LAYA_PREFETCH_MODEL` | `1` = download the model during `npm install` |
| `LAYA_SKIP_MODEL_DOWNLOAD` | `1` = never download, never prompt |
| `LAYA_API_KEY` / `API_KEY` | require `Authorization: Bearer <key>` |
| `LAYA_SERVE_BIN` | use a specific `laya-serve` binary |

Offline or air-gapped:

```bash
LAYA_PREFETCH_MODEL=1 npm install laya-system-one   # fetch during install
LAYA_MODEL_PATH=/opt/models/model.onnx              # or bring your own copy
LAYA_MODEL_CHUNKS_DIR=/opt/models/chunks            # or a directory of chunks
```

## Performance

Measured on real hardware, on every platform we ship a binary for, with the
default `native` backend. Run `npm run bench` to measure your own.

| platform | load | first answer | warm (4 q/call) | per question |
|---|---|---|---|---|
| linux-arm64 | 1.6 s | 184 ms | 145 ms | 40 ms |
| linux-arm64 (musl) | 1.9 s | 247 ms | 154 ms | 36 ms |
| windows-x64 | 1.7 s | 175 ms | 149 ms | 40 ms |
| windows-arm64 | 1.4 s | 231 ms | 178 ms | 47 ms |
| macOS-arm64 | 1.3 s | 268 ms | 220 ms | 51 ms |
| linux-x64 (musl) | 2.3 s | 387 ms | 253 ms | 59 ms |
| linux-x64 | 2.5 s | 331 ms | 264 ms | 63 ms |
| macOS-x64 | 2.9 s | 387 ms | 360 ms | 84 ms |

`load` is reading the model, `first answer` includes warmup, and the warm
numbers are the sustained latency. Shared CI runners vary by ~20% between
runs, so treat these as orders of magnitude.

The `wasm` backend is roughly 100x slower — it exists so browsers and unusual
platforms work at all, not for throughput.

## Requirements

| | |
|---|---|
| **Node.js** | ≥ 18.17 |
| **Bun** | ≥ 1.0 |
| **Browsers** | the `wasm` backend |
| **OS** | Linux (glibc and musl/Alpine), macOS (arm64 and x64), Windows (x64 and arm64) |
| **Docker** | Debian, Ubuntu, Alpine |

No runtime dependencies. The right native binary for your machine is installed
automatically; there is nothing to compile and no system packages to add.

## What gets installed

The package is small and the heavy parts arrive as dependencies npm selects
for your platform, so you download only what you can run:

| | size |
|---|---|
| `laya-system-one` (code, tokenizer, wasm engine) | ~8.5 MB |
| the one native binary for your platform | 8–26 MB |
| the 13 model chunks | ~235 MB total |
| the model on disk, after the first run | ~324 MB |

The model is written next to the package when that directory is writable, and
to your user cache otherwise — so `npm i -g` and read-only containers work
without extra configuration. Every copy is checksum-verified, and a run that
is killed mid-download leaves nothing corrupt behind.

## Development

```bash
npm install
npm run check            # lint, unit, packaging, integration, e2e + install rehearsal
npm run check:quick      # the same minus the model-backed suites
npm run test:rehearsal   # install from a local registry and use it, Node + Bun
npm run bench            # measure on this machine
npm run lint             # syntax + packaging + docs consistency
```

CI builds every platform, proves each binary answers 10 questions, and uploads
the packages as artifacts. `verify-published.yml` installs a published version
from the real registry on every platform — Node and Bun, including Alpine for
musl — and runs a real inference.

## License

Apache-2.0 — see [LICENSE](LICENSE).
