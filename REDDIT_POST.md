# Jev, but it runs on your machine: swap one base URL and you're local

*Draft for r/LocalLLaMA. If you already call TypeSafe's Jev, the whole migration is at the top. Everything measured is from the published package or the upstream Laya benchmarks; the Jev figures are TypeSafe's own published numbers, not measured by me.*

---

## If you already use Jev, read only this

You have a call that looks like this:

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "I have been trying to connect my Stripe account for 3 days and the integration keeps failing. I am losing sales.",
    "model": "jev-latest",
    "questions": {
      "urgency": { "type": "noul", "instructions": "Does this message express urgency?" }
    }
  }'
```

Run this in a second terminal:

```bash
npx laya-system-one --port 8080
```

Then change the base URL — one string — and drop the `Authorization` header:

```bash
curl -X POST http://localhost:8080/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "state": "I have been trying to connect my Stripe account for 3 days and the integration keeps failing. I am losing sales.",
    "model": "laya-multilingual",
    "questions": {
      "urgency": { "type": "noul", "instructions": "Does this message express urgency?" }
    }
  }'
```

Same `state`, same `questions`, same three primitives, same response fields. That's the entire migration. In your client it's usually one line:

```diff
- const baseUrl = "https://api.typesafe.ai";
+ const baseUrl = "http://localhost:8080";
```

Notes for the swap:

- **`model`**: Jev expects `jev-latest`; this server ignores the value and echoes `laya-multilingual`. Change it if your client asserts on the model name.
- **Auth**: local is open by default. Add `--api-key secret` and keep sending the Bearer header if you want it to behave identically.
- **Response shape**: the fields a Jev client reads are all there — `choice` / `score` / `noul`, `probabilities`, `confidence`, `legend`, `usage`. Laya adds a couple of extras on `noul` (`threshold`, `decision`), which is additive and won't break an existing reader.

**You don't need to know npm for this.** `npx` downloads and runs the package in one shot — no `npm install`, no `package.json`, no `node_modules` in your project, nothing to clean up afterwards. If you use Bun, `bunx laya-system-one --port 8080` is the same thing. If you'd rather have it installed permanently, `npm install -g laya-system-one` then just `laya-system-one --port 8080`.

First run downloads the model (~324 MB) once and caches it. After that it's offline.

---

## What just happened

That server is **Laya** — an open-weight, Apache-2.0 System One model from Convai Innovations — running through a runtime I built so it needs no Python, no PyTorch, no ONNX Runtime and no cloud call. `dependencies` is empty; inference is a self-contained Rust binary that ships inside the npm package. It runs on Node.js, Bun, and in the browser via WebAssembly.

The point of the exercise: Jev is genuinely good and genuinely hosted. If you want the same interface without the per-call fee, without a vendor in the request path, and without your data leaving the machine, this is the closest thing that exists today.

---

## Why bother, if Jev works

| | Laya (local, this package) | Jev (hosted) |
| :--- | ---: | ---: |
| Cost | **Free / local** | $0.042 per MTok input |
| Data leaves your machine | **No** | Yes |
| Self-hostable | **Yes** | No |
| Fine-tunable | **Yes** | No |
| License | **Apache-2.0** | Hosted API |
| p50 latency, 1 question | **32.8 ms** (T4) | 236–276 ms |
| Context | 8,192 | 64k |
| typed-decisions benchmark | **0.766** | 0.727 |
| AG News | **0.953** | 0.910 |
| DAIR Emotion | **0.600** | 0.480 |
| banking77 (77 labels) | 0.492 | **0.870** |
| Calibration out of the box | over-confident (ECE 0.466) | **0.246** |

Caveat on those rows, stated by the upstream project itself: **the Jev figures are third-party published and were never measured by them** (no API access), so prompts and sample sizes differ. Read it as indicative, not a controlled head-to-head.

---

## Where Jev is still the better choice

I'm not going to pretend otherwise:

- **Many options in one `choice`.** banking77 is 0.492 vs 0.870, and it's architectural: a `choice` question's options share a fixed token budget, so 77 labels get ~4 tokens each and stop being distinguishable. Both base checkpoints score *exactly* 0.425 here — a budget ceiling, not a capability gap. **Keep `choice` questions under ~20 options.**
- **Long context.** 64k vs 8,192 (and the English checkpoint is 512).
- **Calibration on day one.** Laya ships over-confident. Refitting a temperature per (question type, option count) drops ECE from 0.466/0.314 to **0.081/0.106** — better than Jev's 0.246, but it's work you have to do. Jev optimizes calibration during training, so a confidence threshold means something immediately.
- **Option-order robustness** at 20 options: Laya 0.15–0.23 vs Jev 0.13.

## Where Laya wins

- **It's yours.** Apache-2.0 weights, self-hosted, no per-call fee, no vendor dependency, data never leaves your network.
- **You can fine-tune it.** On typed-decisions the base checkpoints score *below the majority-class baseline* (0.362/0.352 vs 0.461) — all the capability comes from fine-tuning, and the fine-tuned checkpoint reaches 0.766. There's a free Kaggle notebook that runs the whole loop on 2×T4.
- **Multilingual is measured.** Across all 51 MASSIVE languages, `laya-multilingual` clears 3× random in **45/51** (macro accuracy 0.3661), while the English checkpoint collapses outside English (Khmer: 0.000 accuracy at 0.952 confidence — confident and wrong, which is why routing happens before the forward pass).
- **Speed, especially batched.** One question is ~6–7× faster than Jev's measured p50; 50 questions in one call is 337 ms on a T4 (~7.2 ms/question).

### The rest of the honest caveats

- **Moderation on held-out data is near chance** (0.530, macro-F1 0.400). Hand-picked examples work; real traffic doesn't.
- **Ordinal `score` is the weakest primitive** (SST-5 0.372).
- **Accuracy degrades with length** — 16–18 of 20 correct up to ~4,000 tokens, 8–17 beyond.
- **CPU cost grows faster than the input** (attention is quadratic): 2,000 tokens ≈ 6 s, 4,000 ≈ 21 s, 8,000 ≈ 190 s on one Windows-arm64 box. Upstream's "1.7 s for 4,000 tokens" is an Apple GPU with PyTorch; CPU/ONNX is a different world.
- **WebAssembly is ~40× slower** than native. It exists so browsers and odd platforms work at all, not for throughput.

---

## Measured latency (native backend, 4 questions per call)

| Platform | Load | First answer | Warm | Per question |
| :--- | ---: | ---: | ---: | ---: |
| Linux arm64 | 1.6 s | 184 ms | 145 ms | 40 ms |
| Windows x64 | 1.7 s | 175 ms | 149 ms | 40 ms |
| Windows arm64 | 1.4 s | 231 ms | 178 ms | 47 ms |
| macOS arm64 | 1.3 s | 268 ms | 220 ms | 51 ms |
| Linux x64 | 2.5 s | 331 ms | 264 ms | 63 ms |
| macOS x64 | 2.9 s | 387 ms | 360 ms | 84 ms |

`npm run bench` measures your own machine.

---

## If you'd rather skip HTTP entirely

In-process, no server, no network hop:

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
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['not urgent', 'soon', 'blocking']
    },
    churn: { type: 'noul', instructions: 'Is the user at churn risk?', threshold: 0.5 }
  }
);

console.log(out.answers.department.choice);   // "billing"
console.log(out.answers.urgency.score);       // 1.95
console.log(out.answers.churn.noul);          // 0.87
```

In a browser, no build step:

```html
<script type="module">
  import { Laya } from 'https://esm.sh/laya-system-one';
  const laya = await Laya.load({ modelDir: '/models/' });
  const out = await laya.predict('We were billed twice and want a refund.', { /* ... */ });
</script>
```

---

## What this package adds (and what it doesn't)

The model is **theirs and unchanged** — `convaiinnovations/laya-multilingual`, exported to ONNX and quantized to INT8. What I built is the runtime around it:

- **No Python, no PyTorch, no ONNX Runtime to install.** A self-contained Rust binary (Axum + `tract` + the `tokenizers` crate) ships with the package. `dependencies` is empty.
- **The tokenizer is pure JavaScript**, reproducing the upstream `tokenizer.json` pipeline exactly — verified token-for-token against the `tokenizers` crate over 95 cases, including the whitespace-run added tokens and `<mask>`'s `lstrip`. Both backends see identical input ids, which is what makes them agree on answers.
- **Node.js, Bun and browsers.** Native binary on Node/Bun, bundled WebAssembly for the browser.
- **Linux (glibc + musl/Alpine), macOS (arm64 + x64), Windows (x64 + arm64).** npm installs only the binary for your machine (8–27 MB), not all six.
- **Jev wire-compatible** `POST /v1/systemone`.
- **Model over npm.** The 324 MB checkpoint is split into 13 chunk packages, reassembled locally and sha256-verified with atomic writes — no dependency on a single download source.

**Links**

- npm: [`laya-system-one`](https://www.npmjs.com/package/laya-system-one)
- Repo: [italoalmeida0/laya-system-one](https://github.com/italoalmeida0/laya-system-one)
- Upstream: [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) · model: [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual)
- Jev: [jevapi.dev](https://jevapi.dev/) · [docs.typesafe.ai](https://docs.typesafe.ai/)

The model, the architecture, the RLCD method and the wire protocol are all Convai Innovations' work. This package only makes it run where Python isn't an option. If it's useful, the credit belongs upstream — please star the original repo.

Apache-2.0, same as upstream. Happy to hear if the port got anything wrong, or if there's a checkpoint you'd rather see shipped (`laya` English and `laya-typed-decisions` are both candidates).
