# Laya System-One ⚡

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Runtime](https://img.shields.io/badge/Runtime-Node.js%20%7C%20Bun%20%7C%20Browser-green.svg)]()
[![TypeSafe Jev](https://img.shields.io/badge/Wire%20Protocol-TypeSafe%20Jev%20Compatible-orange.svg)]()

> **Self-contained, ultra-fast System 1 decision engine with WebGPU and WASM SIMD acceleration. Drop-in, 100% wire-compatible replacement for the TypeSafe Jev API (`POST /v1/systemone`).**

Runs entirely on your local machine with **zero Python**, **zero PyTorch**, and **zero external network requests** at runtime. The INT8 multilingual model (~324 MB) is embedded directly within the package, enabling secure, air-gapped corporate deployments with sub-20ms inference latency.

---

## 🌟 Why Laya System-One?

- 🔒 **100% Offline & Air-Gapped:** Zero external calls to Hugging Face or cloud APIs at runtime. Ideal for secure corporate intranets, edge servers, and privacy-sensitive workflows.
- ⚡ **Sub-20ms Latency:** Executes non-autoregressive decision classification in ~15ms on modern CPUs via native C++/SIMD and WebGPU.
- 🔄 **TypeSafe Jev Wire-Compatible:** Drop-in emulation of TypeSafe Jev's `POST /v1/systemone` endpoint. Any existing Jev client or SDK can connect immediately simply by changing the base URL.
- 🌍 **True Multilingual Understanding:** Built on multilingual representations supporting over 100 languages (English, Portuguese, Spanish, German, French, Chinese, Japanese, etc.) out-of-the-box.
- 💻 **Universal JavaScript Support:** Works seamlessly across **Node.js** (>=18), **Bun**, **Deno**, and modern web browsers.
- 📦 **Dual Operation Modes:** Run as an independent local HTTP daemon via the CLI (`npx laya-system-one`) or import in-memory into your application process for zero network overhead.

---

## 📦 Installation

```bash
# Using npm
npm install laya-system-one

# Using bun
bun add laya-system-one

# Using pnpm
pnpm add laya-system-one
```

---

## 🚀 Quick Start

### 1. Launch HTTP Microservice via CLI

To spin up a TypeSafe Jev-compatible server on port `8080`:

```bash
npx laya-system-one --port 8080
```

#### CLI Options:

| Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--port <number>` | `PORT` | `8080` | Port to bind the HTTP server |
| `--host <string>` | `HOST` | `0.0.0.0` | Host address to bind |
| `--device <type>` | `DEVICE` | `auto` | Execution backend: `auto`, `webgpu`, `wasm`, `cpu` |
| `--api-key <token>`| `LAYA_API_KEY` | *(none)* | Require Bearer authentication on `/v1/systemone` |

Example with authentication enabled:

```bash
npx laya-system-one --port 8080 --api-key secret-token-xyz
```

---

### 2. In-Process Programmatic Usage (Zero Network Latency)

You can evaluate states directly in memory inside your Node.js or Bun backend:

```javascript
import { Laya } from 'laya-system-one';

// 1. Initialize engine (device: 'auto' | 'webgpu' | 'wasm' | 'cpu')
const laya = await Laya.load({ device: 'auto' });

// 2. Define state (string, object, or array)
const state = {
  customer_id: 'cust_9821',
  message: 'We were charged twice on our March invoice. Please refund the duplicate amount or we will cancel our plan.'
};

// 3. Define typed questions (choice, score, noul)
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

// 4. Evaluate state
const result = await laya.predict(state, questions);

console.log(result.answers.department.choice);       // -> "billing"
console.log(result.answers.department.confidence);   // -> 1.0 (100%)
console.log(result.answers.urgency.score);           // -> 1.95 (High urgency)
console.log(result.answers.churn_risk.noul);         // -> 0.968 (96.8% probability)
console.log(result.answers.churn_risk.decision);     // -> true (Passed threshold 0.5)
```

---

### 3. Programmatic HTTP Server

Spin up the HTTP server inside your existing JavaScript application:

```javascript
import { serve } from 'laya-system-one';

const { url, close } = await serve({
  host: '127.0.0.1',
  port: 8080,
  apiKey: 'optional-bearer-key'
});

console.log(`Laya Jev server running at ${url}/v1/systemone`);

// To stop gracefully later:
// close();
```

---

## 📡 HTTP API Reference (TypeSafe Jev Wire Compatible)

### Evaluation Endpoint

```http
POST /v1/systemone
Host: localhost:8080
Content-Type: application/json
Authorization: Bearer <API_KEY>   [Optional unless configured]
```

### Request Body

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `state` | `string` \| `object` \| `array` | **Yes** | The context, text, or structured data being evaluated. |
| `questions` | `Record<string, Question>` | **Yes** | Map of question keys to typed question objects. |
| `model` | `string` | No | Model name (defaults to `laya-multilingual`, echoed back). |

---

### Question Specifications

#### 1. `choice` Question
Multi-class classification between distinct options.

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

#### 2. `score` Question
Continuous ordinal scoring along an ordered scale of criteria levels.

```json
{
  "type": "score",
  "instructions": "Rate the severity of the issue.",
  "criteria": [
    "Minor cosmetic issue",
    "Degraded functionality",
    "Critical full service outage"
  ]
}
```

#### 3. `noul` Question
Calibrated binary verification (0.0 to 1.0).

```json
{
  "type": "noul",
  "instructions": "Does the user explicitly request a refund?",
  "threshold": 0.6
}
```

---

### Example cURL Request

```bash
curl -X POST http://localhost:8080/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "state": {
      "text": "Fui cobrado duas vezes na minha fatura. Reembolsem imediatamente."
    },
    "questions": {
      "dept": {
        "type": "choice",
        "instructions": "Which department should respond?",
        "criteria": {
          "billing": "Refunds, invoices, and payments",
          "support": "Technical and product questions"
        }
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

### Example HTTP Response (`200 OK`)

```json
{
  "model": "laya-multilingual",
  "answers": {
    "dept": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {
        "billing": 1.0,
        "support": 0.0
      },
      "confidence": 1.0
    },
    "urgency": {
      "type": "score",
      "score": 1.9482,
      "legend": {
        "0": "Low",
        "1": "Medium",
        "2": "High"
      },
      "probabilities": {
        "0": 0.0011,
        "1": 0.0496,
        "2": 0.9493
      },
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
  "usage": {
    "input_tokens": 82,
    "output_tokens": 12
  }
}
```

### Healthcheck Endpoint

```http
GET /health
```

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "model": "laya-multilingual",
  "version": "1.0.0",
  "protocol": "TypeSafe Jev /v1/systemone compatible"
}
```

### HTTP Error Codes

- `401 Unauthorized`: Returned when `--api-key` is configured on the server and the `Authorization: Bearer <key>` header is missing or invalid.
- `422 Unprocessable Entity`: Returned when the JSON body is invalid or missing required `state` / `questions` fields.

---

## ⚡ Hardware Acceleration Architecture

`laya-system-one` includes a hybrid native runtime that maximizes throughput based on the active runtime:

| Environment | Primary Provider | Fallback Provider | Typical Inference Latency |
| :--- | :--- | :--- | :--- |
| **Node.js** | Native C++ (`cpu`) | WebGPU (`webgpu`) | ~15 ms / query |
| **Bun** | WebAssembly SIMD (`wasm`) | WebGPU (`webgpu`) | ~25 ms / query |
| **Browser** | WebGPU (`navigator.gpu`) | WebAssembly SIMD (`wasm`) | ~18 ms / query |

---

## 📄 License & Attribution

- **License:** [Apache-2.0](LICENSE)
- **Author:** [Italo Almeida](https://github.com/italoalmeida0)
- **GitHub Repository:** [https://github.com/italoalmeida0/laya-system-one](https://github.com/italoalmeida0/laya-system-one)

### Upstream Attribution
This project incorporates and builds upon the foundational research and model architecture of **Laya** by [Convai Innovations](https://github.com/NandhaKishorM/laya) (licensed under Apache-2.0). All appropriate copyright notices and license requirements are preserved in compliance with Section 4 of the Apache License 2.0.
