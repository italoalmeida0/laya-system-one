# Laya System-One ⚡

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Runtime](https://img.shields.io/badge/Runtime-Node.js%20%7C%20Bun%20%7C%20Browser-green.svg)]()
[![TypeSafe Jev](https://img.shields.io/badge/Wire%20Protocol-TypeSafe%20Jev%20Compatible-orange.svg)]()
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)]()
[![Built on Laya](https://img.shields.io/badge/Built%20on-Laya%20by%20Convai%20Innovations-8A2BE2.svg)](https://github.com/NandhaKishorM/laya)

> **A fast, self-contained decision engine. Give it any text and a set of typed questions, and it answers them — offline, in milliseconds, in over 100 languages. Drop-in compatible with the TypeSafe Jev API (`POST /v1/systemone`).**

Runs entirely on your machine. No Python, no PyTorch, no API keys, no cloud
calls at inference time. One `npm install` and it works.

> **Built on [Laya](https://github.com/NandhaKishorM/laya)** by
> [Convai Innovations](https://huggingface.co/convaiinnovations) — a
> community project. The model is theirs; this package makes it run in
> Node.js, Bun and the browser with no Python in the loop. See
> [Credits](#-credits).

---

## 🌟 Why Laya System-One?

- 🔒 **100% Offline:** Nothing leaves your machine. Ideal for corporate
  intranets, edge servers and privacy-sensitive workflows.
- ⚡ **Fast:** ~40 ms per question on a warm engine, measured on every platform
  we ship for.
- 🔄 **TypeSafe Jev Compatible:** Drop-in `POST /v1/systemone`. Point an
  existing Jev client at it and it just works.
- 🌍 **Multilingual:** Understands English, Portuguese, Spanish, German,
  French, Chinese, Japanese and 100+ more, out of the box.
- 💻 **Node.js, Bun and Browsers:** Native binary on Node and Bun, WebAssembly
  in the browser.
- 📦 **Zero Dependencies:** `dependencies` is empty. Nothing to compile,
  nothing to install system-wide, nothing to keep patched.
- 🧩 **Two Ways to Run It:** As a local HTTP service via the CLI, or in-process
  for zero network overhead.

---

## 📦 Installation

```bash
# npm
npm install laya-system-one

# bun
bun add laya-system-one

# pnpm
pnpm add laya-system-one
```

The right engine for your machine is installed automatically. The model
(~324 MB) is fetched once on first use and cached.

---

## 🚀 Quick Start

### 1. Launch the HTTP service

```bash
npx laya-system-one --port 8080
```

| Flag | Env | Default | Description |
| :--- | :--- | :--- | :--- |
| `--port <number>` | `PORT` | `8080` | Port to bind |
| `--host <string>` | `HOST` | `0.0.0.0` | Address to bind |
| `--backend <type>` | `LAYA_BACKEND` | `native` | `native` or `wasm` |
| `--api-key <token>` | `LAYA_API_KEY` | *(none)* | Require Bearer auth on `/v1/systemone` |

With authentication:

```bash
npx laya-system-one --port 8080 --api-key secret-token-xyz
```

### 2. Use it in-process (zero network overhead)

```javascript
import { Laya } from 'laya-system-one';

// 1. Initialize the engine
const laya = await Laya.load();

// 2. Define the state (string, object, or array)
const state = {
  customer_id: 'cust_9821',
  message: 'We were charged twice on our March invoice. Please refund the duplicate amount or we will cancel our plan.'
};

// 3. Define typed questions
const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team should resolve this customer inquiry?',
    criteria: {
      billing: 'Invoices, refunds, and duplicate charges',
      tech_support: 'Software bugs, outages, and error messages',
      sales: 'Upgrades, plan changes, and enterprise contracts'
    }
  },
  urgency: {
    type: 'score',
    instructions: 'Assess the urgency level of this inquiry.',
    criteria: ['Low / routine', 'Moderate', 'Critical / blocking / angry']
  },
  churn_risk: {
    type: 'noul',
    instructions: 'Does this message present an explicit risk of customer churn?',
    threshold: 0.5
  }
};

// 4. Evaluate
const result = await laya.predict(state, questions);

console.log(result.answers.department.choice);     // -> "billing"
console.log(result.answers.department.confidence); // -> 1.0
console.log(result.answers.urgency.score);         // -> 1.95
console.log(result.answers.churn_risk.noul);       // -> 0.968
console.log(result.answers.churn_risk.decision);   // -> true
```

### 3. Serve it from inside your app

```javascript
import { serve } from 'laya-system-one';

const srv = await serve({ host: '127.0.0.1', port: 8080, apiKey: 'optional-key' });

console.log(`Laya server running at ${srv.url}/v1/systemone`);

// later:
await srv.close();
```

### `Laya.load(options)` options

| Option | Default | Description |
| :--- | :--- | :--- |
| `backend` | `'native'` | `native` (bundled Rust server) or `wasm` |
| `modelDir` | the package's `models/` | where `model.onnx` and `tokenizer.json` live |
| `maxLen` | `2048` | token budget for the state — raise it for long documents (max 8192, see [Long inputs](#long-inputs)) |
| `apiKey` | `null` | require a Bearer token on the HTTP layer |
| `port` / `host` | `0` / `127.0.0.1` | where the native server binds |
| `threads` | `0` | inference threads (`0` = runtime default) |

---

## 📡 HTTP API Reference (TypeSafe Jev compatible)

```http
POST /v1/systemone
Host: localhost:8080
Content-Type: application/json
Authorization: Bearer <API_KEY>   [optional unless configured]
```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `state` | `string` \| `object` \| `array` | **Yes** | The context or text being evaluated. |
| `questions` | `Record<string, Question>` | **Yes** | Map of question keys to typed questions. |
| `model` | `string` | No | Model name (defaults to `laya-multilingual`, echoed back). |

### Question types

**`choice`** — pick one of several options:

```json
{
  "type": "choice",
  "instructions": "Which department should handle this ticket?",
  "criteria": {
    "billing": "Invoices and credit card transactions",
    "technical": "Software bugs and service disruptions"
  }
}
```

**`score`** — place on an ordered scale:

```json
{
  "type": "score",
  "instructions": "Rate the severity of the issue.",
  "criteria": ["Minor cosmetic issue", "Degraded functionality", "Critical full service outage"]
}
```

**`noul`** — calibrated yes/no probability:

```json
{
  "type": "noul",
  "instructions": "Does the user explicitly request a refund?",
  "threshold": 0.6
}
```

### Example request

```bash
curl -X POST http://localhost:8080/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "state": { "text": "Fui cobrado duas vezes na minha fatura. Reembolsem imediatamente." },
    "questions": {
      "dept": {
        "type": "choice",
        "instructions": "Which department should respond?",
        "criteria": { "billing": "Refunds, invoices, and payments", "support": "Technical and product questions" }
      },
      "urgency": {
        "type": "score",
        "instructions": "Urgency rating",
        "criteria": ["Low", "Medium", "High"]
      },
      "refund_demanded": {
        "type": "noul",
        "instructions": "Is the customer requesting a refund?",
        "threshold": 0.5
      }
    }
  }'
```

### Example response

```json
{
  "model": "laya-multilingual",
  "answers": {
    "dept": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 1.0, "support": 0.0 },
      "confidence": 1.0
    },
    "urgency": {
      "type": "score",
      "score": 1.9482,
      "legend": { "0": "Low", "1": "Medium", "2": "High" },
      "probabilities": { "0": 0.0011, "1": 0.0496, "2": 0.9493 },
      "confidence": 0.9493
    },
    "refund_demanded": {
      "type": "noul",
      "noul": 0.9852,
      "confidence": 0.9852,
      "threshold": 0.5,
      "decision": true
    }
  },
  "usage": { "input_tokens": 82, "output_tokens": 12 }
}
```

### Healthcheck

```http
GET /health
```

```json
{
  "status": "ok",
  "model": "laya-multilingual",
  "version": "1.1.0",
  "protocol": "TypeSafe Jev /v1/systemone compatible"
}
```

### Error codes

- `401 Unauthorized` — API key configured, header missing or wrong.
- `422 Unprocessable Entity` — invalid JSON, or `state`/`questions` missing.
- `404 Not Found` — unknown route.
- `413 Payload Too Large` — body over 4 MB.

---

## ⚙️ Backends

| Backend | How it runs | When to use |
| :--- | :--- | :--- |
| **`native`** *(default)* | A self-contained Rust server bundled with the package | The normal choice. Fastest, nothing to install. |
| **`wasm`** | Pure Rust compiled to WebAssembly, also bundled | Browsers, or platforms with no native build. |

Both ship inside the package — nothing is compiled or downloaded at install
time. Switch with `--backend wasm` or `LAYA_BACKEND=wasm`.

---

## 📊 Performance

Measured on real hardware, on every platform we ship a binary for, with the
default `native` backend. Run `npm run bench` to measure your own machine.

| Platform | Load | First answer | Warm (4 q/call) | Per question |
| :--- | ---: | ---: | ---: | ---: |
| macOS arm64 | 1.3 s | 268 ms | 220 ms | 51 ms |
| Windows arm64 | 1.4 s | 231 ms | 178 ms | 47 ms |
| Linux arm64 | 1.6 s | 184 ms | 145 ms | 40 ms |
| Windows x64 | 1.7 s | 175 ms | 149 ms | 40 ms |
| Linux arm64 (musl) | 1.9 s | 247 ms | 154 ms | 36 ms |
| Linux x64 (musl) | 2.3 s | 387 ms | 253 ms | 59 ms |
| Linux x64 | 2.5 s | 331 ms | 264 ms | 63 ms |
| macOS x64 | 2.9 s | 387 ms | 360 ms | 84 ms |

`Load` is reading the model into memory. `First answer` includes warmup. The
warm numbers are sustained latency. Shared CI runners vary by ~20% between
runs, so treat these as orders of magnitude rather than exact figures.

The `wasm` backend is roughly 100x slower — it exists so browsers and unusual
platforms work at all, not for throughput.

### Long inputs

The model reads up to **8,192 tokens**, but it ships with a conservative
**2,048-token** budget so it stays usable on weak machines. The budget is a
cap, not a cost: **short inputs are unaffected by raising it** — a 74-token
question answers in ~90 ms whatever the limit is, because the work follows the
input's real length.

Raise it when your inputs are long documents:

```bash
LAYA_MAX_LEN=8192 npx laya-system-one --port 8080
```

```js
const laya = await Laya.load({ maxLen: 8192 });
```

Measured on one machine (Windows arm64, `native` backend), by input length:

| tokens | default (2048) | `maxLen: 8192` |
| ---: | ---: | ---: |
| 74 | 88 ms | 88 ms |
| 1,000 | 0.9 s | 0.9 s |
| 2,000 | 6.4 s | 6.4 s |
| 4,000 | 9.2 s *(truncated)* | 21.3 s |
| 8,000 | 9.2 s *(truncated)* | 190 s |

Two things worth knowing before you raise it:

- **Accuracy degrades with length.** Upstream measured 16–18 of 20 requests
  correct up to about 4,000 tokens, and 8–17 of 20 beyond that. Check your own
  data — long-document accuracy is not something to assume.
- **Cost grows steeply.** Past ~2,000 tokens the time climbs faster than the
  input does (attention is quadratic). 8,000 tokens is minutes, not seconds,
  on a CPU. If you routinely handle documents that long, truncate them
  yourself to the part that matters, or run the upstream Python package on a
  GPU.

Truncation is the real risk of leaving it at the default: a long message gets
cut off and the answer can be wrong rather than slow. On a ~3,000-token input
the shipped default answered `sales` where the full text answers `billing`.

---

## 🧾 Environment variables

| Variable | Effect |
| :--- | :--- |
| `LAYA_BACKEND` | `native` or `wasm` |
| `LAYA_MAX_LEN` | token budget for the state (default 2048, max 8192) |
| `LAYA_MODEL_PATH` | Use a `model.onnx` you already have (file or directory) |
| `LAYA_MODEL_CHUNKS_DIR` | Directory holding the model chunks |
| `LAYA_MODEL_URL` | Override where the model is downloaded from |
| `LAYA_CACHE_DIR` | Where the model is cached |
| `LAYA_PREFETCH_MODEL` | `1` = download the model during `npm install` |
| `LAYA_SKIP_MODEL_DOWNLOAD` | `1` = never download, never prompt |
| `LAYA_API_KEY` / `API_KEY` | Require `Authorization: Bearer <key>` |
| `LAYA_SERVE_BIN` | Use a specific `laya-serve` binary |

**Offline or air-gapped:**

```bash
LAYA_PREFETCH_MODEL=1 npm install laya-system-one   # fetch during install
LAYA_MODEL_PATH=/opt/models/model.onnx              # or bring your own copy
LAYA_MODEL_CHUNKS_DIR=/opt/models/chunks            # or a directory of chunks
```

---

## 💻 Requirements

| | |
| :--- | :--- |
| **Node.js** | ≥ 18.17 |
| **Bun** | ≥ 1.0 |
| **Browsers** | The `wasm` backend |
| **OS** | Linux (glibc and musl/Alpine), macOS (arm64 and x64), Windows (x64 and arm64) |
| **Docker** | Debian, Ubuntu, Alpine |

No runtime dependencies. The right native binary for your machine is installed
automatically — nothing to compile, no system packages to add.

---

## 📥 What gets installed

The package itself is small; the heavy parts arrive as dependencies npm picks
for your platform, so you only download what you can run.

| | Size |
| :--- | ---: |
| `laya-system-one` (code, tokenizer, wasm engine) | ~8.5 MB |
| The one native binary for your platform | 8–26 MB |
| The 13 model chunks | ~235 MB total |
| The model on disk, after the first run | ~324 MB |

The model is written next to the package when that directory is writable, and
to your user cache otherwise — so `npm i -g` and read-only containers work
without extra configuration. Every copy is checksum-verified, and a run that
is killed mid-download leaves nothing corrupt behind.

---

## 🛠️ Development

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

---

## 🙏 Credits

**This package would not exist without
[Laya](https://github.com/NandhaKishorM/laya).** It is a community project by
[Convai Innovations](https://huggingface.co/convaiinnovations) — the model,
the architecture, the training method and the wire protocol are all theirs.
What this package adds is a way to run it where Python is not an option:
Node.js, Bun and the browser.

| | |
| :--- | :--- |
| **Upstream project** | [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) |
| **Model** | [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual) (mmBERT-base, 322M params) |
| **Other checkpoints** | [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya) (English), [`laya-typed-decisions`](https://huggingface.co/convaiinnovations/laya-typed-decisions) |
| **Demo** | [Hugging Face Space](https://huggingface.co/spaces/convaiinnovations/laya-demo) |
| **Method** | RLCD — reinforcement learning against strictly proper scoring rules |
| **License** | Apache-2.0 (upstream and this package alike) |

If you find this useful, the credit belongs upstream — star
[their repository](https://github.com/NandhaKishorM/laya) and consider
[supporting the author](https://www.buymeacoffee.com/nandakishorm).

## 📄 License

[Apache-2.0](LICENSE) — the same license as the upstream project.

- **This package:** [Italo Almeida](https://github.com/italoalmeida0) —
  [laya-system-one](https://github.com/italoalmeida0/laya-system-one)
- **Model & upstream:** Convai Innovations —
  [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)
