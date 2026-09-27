# Laya in one command: `npm install` and it just works — anywhere, with zero dependencies

First of all: thank you for Laya. The model, the RLCD method and the wire
protocol are genuinely good work, and the fact that it runs as a single
non-autoregressive pass is what makes it usable for the kind of triage work I
needed it for.

I kept running into the same wall though: **Python**. The service I wanted to
put this in is Node.js, and the machines it has to run on are not places where
I can install PyTorch — a corporate Windows box, a small Linux container, a
Bun runtime, and occasionally a browser. So I built a way to run your model
where Python is not an option, and published it.

## `npm install laya-system-one`

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
    churn: { type: 'noul', instructions: 'Is the user at churn risk?', threshold: 0.5 }
  }
);

console.log(out.answers.department.choice); // "billing"
console.log(out.answers.churn.noul);        // 0.87
```

Or as a service, same `/v1/systemone` wire format:

```bash
npx laya-system-one --port 8080
```

## What it actually is

The model is **yours** — `convaiinnovations/laya-multilingual`, exported to
ONNX and quantized to INT8, unchanged. What this package adds is a runtime:

- **No Python, no PyTorch, no ONNX Runtime to install.** The inference server
  is a self-contained Rust binary (Axum + `tract` + the `tokenizers` crate)
  that ships with the package. `dependencies` is empty.
- **The tokenizer is pure JavaScript**, reproducing your `tokenizer.json`
  pipeline exactly — verified token-for-token against the `tokenizers` crate
  on 95 cases, including the whitespace-run added tokens and `<mask>`'s
  `lstrip`.
- **Runs on Node.js, Bun and in the browser** (a bundled WebAssembly build for
  the browser and for platforms with no native binary).
- **Linux (glibc and musl/Alpine), macOS (arm64 and x64), Windows (x64 and
  arm64)** — the right binary is selected by npm for the machine, so you
  download 8–27 MB of binary, not the ~205 MB of all six.

## Numbers, measured not claimed

Per question, warm, `native` backend (4 questions per call):

| Platform | Per question |
| :--- | ---: |
| Linux arm64 | 40 ms |
| Windows x64 | 40 ms |
| Windows arm64 | 47 ms |
| macOS arm64 | 51 ms |
| Linux x64 | 63 ms |
| macOS x64 | 84 ms |

Model load is 1.3–2.9 s depending on the platform. The WebAssembly backend is
roughly 100x slower — it is there so browsers and unusual platforms work at
all, not for throughput.

## On the 8,192-token context

This is the part I want to flag, because it bit me. The shipped budget was
1,024 tokens, so a long message was **truncated and misread** — a
~3,000-token input answered `sales` where the full text answers `billing`.
That is a wrong answer, not a slow one, and nothing said so.

The next release makes it configurable (`LAYA_MAX_LEN=8192`,
`Laya.load({ maxLen: 8192 })`, or `--max-len` on the binary) with a 2,048
default. Two honest caveats, both from your own benchmark and my own
measurements:

- **Accuracy degrades with length** — your numbers show 16–18 of 20 correct up
  to ~4,000 tokens and 8–17 of 20 beyond.
- **CPU cost grows faster than the input.** On one Windows arm64 machine:
  2,000 tokens ≈ 6 s, 4,000 ≈ 21 s, 8,000 ≈ 190 s. Your README's "about 1.7 s"
  is on an Apple GPU with PyTorch; on CPU/ONNX it is a different world, and I
  document both rather than implying the faster one.

## What I did not do

- I did not touch the model, the architecture or the training. If you
  re-export the checkpoint, `tools/export-model.py` in the repo reproduces the
  ONNX/INT8 build and `tools/model-diff.js` proves a new file answers the same
  as the old one before it ships.
- I did not reimplement your prompt format from scratch — `build_sequence` is
  ported faithfully, and the answers match the Python runtime on the prompts I
  tested.

## Links

- **npm:** [`laya-system-one`](https://www.npmjs.com/package/laya-system-one)
- **Repository:** [italoalmeida0/laya-system-one](https://github.com/italoalmeida0/laya-system-one)
- **Upstream:** [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) ·
  [model](https://huggingface.co/convaiinnovations/laya-multilingual)

Apache-2.0, same as upstream. If this is useful to anyone, the credit belongs
here — please star the original repository.

Happy to hear if the port got anything wrong, or if there is a checkpoint you
would rather see shipped (`laya` English and `laya-typed-decisions` are both
candidates).
