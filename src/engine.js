import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamic runtime resolver:
// - In Node.js: uses onnxruntime-node (Native C++ CPU at ~15ms + Native WebGPU)
// - In Bun / Browser: uses onnxruntime-web (WASM SIMD + Browser WebGPU via navigator.gpu)
async function getOrt() {
  const isBun = typeof Bun !== 'undefined';
  const isBrowser = typeof window !== 'undefined';

  if (!isBun && !isBrowser) {
    try {
      const mod = await import('onnxruntime-node');
      return mod.default || mod;
    } catch (err) {
      // fallback to onnxruntime-web
    }
  }

  const mod = await import('onnxruntime-web');
  return mod.default || mod;
}

export class LayaEngine {
  constructor(session, config, ort) {
    this.session = session;
    this.config = config;
    this.ort = ort;
  }

  static async load(options = {}) {
    const ort = await getOrt();
    const modelDir = options.modelDir || path.resolve(__dirname, '../models');
    const modelPath = path.join(modelDir, 'model.onnx');
    const configPath = path.join(modelDir, 'rl_agent_config.json');

    let config = {
      max_len: 1024,
      head_max_len: 256,
      temperature: [1.0, 1.0, 1.0],
      temperature_by_options: {}
    };

    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        // fallback
      }
    }

    const device = options.device || 'auto';
    let executionProviders;

    if (device === 'webgpu') {
      executionProviders = ['webgpu'];
    } else if (device === 'wasm' || device === 'cpu') {
      executionProviders = typeof Bun !== 'undefined' || typeof window !== 'undefined' ? ['wasm'] : ['cpu'];
    } else {
      // auto
      executionProviders = typeof Bun !== 'undefined' || typeof window !== 'undefined'
        ? ['webgpu', 'wasm']
        : ['webgpu', 'cpu'];
    }

    const sessionOptions = {
      executionProviders,
      graphOptimizationLevel: 'all'
    };

    const session = await ort.InferenceSession.create(modelPath, sessionOptions);
    return new LayaEngine(session, config, ort);
  }

  async runSingle(item) {
    const seqLen = item.ids.length;
    const numMarkers = item.markers.length;

    const inputIdsData = new BigInt64Array(seqLen);
    const attentionMaskData = new BigInt64Array(seqLen);
    const markerPosData = new BigInt64Array(numMarkers);
    const markerMaskData = new Uint8Array(numMarkers);
    const qtypeData = new BigInt64Array([BigInt(item.qtype)]);

    for (let c = 0; c < seqLen; c++) {
      inputIdsData[c] = BigInt(item.ids[c]);
      attentionMaskData[c] = 1n;
    }

    for (let m = 0; m < numMarkers; m++) {
      markerPosData[m] = BigInt(item.markers[m]);
      markerMaskData[m] = 1;
    }

    const feeds = {
      input_ids: new this.ort.Tensor('int64', inputIdsData, [1, seqLen]),
      attention_mask: new this.ort.Tensor('int64', attentionMaskData, [1, seqLen]),
      marker_pos: new this.ort.Tensor('int64', markerPosData, [1, numMarkers]),
      marker_mask: new this.ort.Tensor('bool', markerMaskData, [1, numMarkers]),
      qtype: new this.ort.Tensor('int64', qtypeData, [1])
    };

    const results = await this.session.run(feeds);
    return Array.from(results.logits.data);
  }

  async run(batch) {
    const allLogits = [];
    for (const item of batch) {
      const logits = await this.runSingle(item);
      allLogits.push(logits);
    }
    return allLogits;
  }
}
