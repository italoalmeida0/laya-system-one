import { loadTokenizer, buildSequence, QTYPES } from './tokenizer.js';
import { LayaEngine } from './engine.js';

/**
 * Compute calibrated confidence score from probability distribution.
 * Normalized between 0.0 and 1.0.
 */
function confidenceFromProbs(probs, k) {
  if (k <= 1) return 1.0;
  const pMax = Math.max(...probs);
  const conf = (pMax - 1.0 / k) / (1.0 - 1.0 / k);
  return Math.min(1.0, Math.max(0.0, conf));
}

/**
 * Numerically stable softmax with temperature scaling.
 */
function softmax(arr, temperature = 1.0) {
  const scaled = arr.map(x => x / Math.max(0.01, temperature));
  const max = Math.max(...scaled);
  const exp = scaled.map(x => Math.exp(x - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(x => x / sum);
}

/**
 * Laya Decision Engine
 * High-performance System-1 non-autoregressive decision engine.
 */
export class Laya {
  constructor(engine, tokenizer) {
    this.engine = engine;
    this.tokenizer = tokenizer;
    this.config = engine.config;
  }

  /**
   * Load Laya model and tokenizer.
   * @param {Object} options - { modelDir, device: 'auto' | 'webgpu' | 'wasm' | 'cpu' }
   */
  static async load(options = {}) {
    const [engine, tokenizer] = await Promise.all([
      LayaEngine.load(options),
      loadTokenizer(options.modelDir)
    ]);
    return new Laya(engine, tokenizer);
  }

  /**
   * Evaluate a state against a map of typed questions (TypeSafe Jev wire protocol).
   * @param {string | object | array} state - The content or structured data to evaluate.
   * @param {Object<string, Object>} questions - Map of question definitions (choice, score, noul).
   * @param {string} [requestedModel] - Optional model identifier to echo back.
   * @returns {Promise<Object>} Formatted answer object matching TypeSafe Jev schema.
   */
  async predict(state, questions = {}, requestedModel = null) {
    const qids = Object.keys(questions);
    const modelName = requestedModel || 'laya-multilingual';

    if (qids.length === 0) {
      return {
        model: modelName,
        answers: {},
        usage: { input_tokens: 0, output_tokens: 0 }
      };
    }

    const maxLen = this.config.max_len || 1024;
    const headMaxLen = this.config.head_max_len || 256;
    const items = [];
    let totalInputTokens = 0;

    for (const qid of qids) {
      const qdef = questions[qid];
      if (!qdef || typeof qdef !== 'object') {
        throw new Error(`Question '${qid}' must be an object.`);
      }

      const qtype = qdef.type || 'choice';
      if (!(qtype in QTYPES)) {
        throw new Error(`Unsupported question type '${qtype}' for question '${qid}'. Must be 'choice', 'score', or 'noul'.`);
      }

      const crit = qdef.criteria;
      let ins = qdef.instructions || '';
      if (typeof ins !== 'string') {
        ins = JSON.stringify(ins);
      }

      const internalQ = {
        t: qtype,
        ins,
        crit: qtype === 'choice' && Array.isArray(crit)
          ? Object.fromEntries(crit.map(c => [c, null]))
          : (crit || {})
      };

      const { ids, markers } = buildSequence(
        this.tokenizer,
        state,
        internalQ,
        maxLen,
        headMaxLen
      );

      totalInputTokens += ids.length;
      items.push({
        qid,
        q: internalQ,
        qdef,
        ids,
        markers,
        qtype: QTYPES[qtype] ?? 0
      });
    }

    const allLogits = await this.engine.run(items);
    const answers = {};

    for (let r = 0; r < items.length; r++) {
      const item = items[r];
      const qid = item.qid;
      const q = item.q;
      const qdef = item.qdef;
      const k = item.markers.length;
      const rowLogits = allLogits[r].slice(0, k);

      // Temperature scaling
      const qt = item.qtype;
      const temp = (this.config.temperature && this.config.temperature[qt]) || 1.0;
      const probs = softmax(rowLogits, temp);
      const conf = Number(confidenceFromProbs(probs, k).toFixed(4));

      if (q.t === 'choice') {
        const keys = Object.keys(q.crit);
        let maxIdx = 0;
        let maxP = -1;
        const probMap = {};

        for (let i = 0; i < keys.length; i++) {
          const p = Number(probs[i].toFixed(4));
          probMap[keys[i]] = p;
          if (p > maxP) {
            maxP = p;
            maxIdx = i;
          }
        }

        answers[qid] = {
          type: 'choice',
          choice: keys[maxIdx],
          probabilities: probMap,
          confidence: conf
        };
      } else if (q.t === 'score') {
        let expectedScore = 0;
        const probMap = {};
        for (let i = 0; i < k; i++) {
          const p = Number(probs[i].toFixed(4));
          probMap[String(i)] = p;
          expectedScore += i * p;
        }

        const legend = Array.isArray(q.crit)
          ? Object.fromEntries(q.crit.map((c, i) => [String(i), c]))
          : q.crit;

        answers[qid] = {
          type: 'score',
          score: Number(expectedScore.toFixed(4)),
          legend,
          probabilities: probMap,
          confidence: conf
        };
      } else {
        // noul (calibrated yes/no score)
        const pTrue = probs[1] !== undefined ? probs[1] : 0.0;
        const noulVal = Number(pTrue.toFixed(4));
        const ans = {
          type: 'noul',
          noul: noulVal,
          confidence: Number(Math.max(pTrue, 1.0 - pTrue).toFixed(4))
        };
        if (qdef.threshold !== undefined && qdef.threshold !== null) {
          ans.threshold = Number(qdef.threshold);
          ans.decision = noulVal >= ans.threshold;
        }
        answers[qid] = ans;
      }
    }

    return {
      model: modelName,
      answers,
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: qids.length * 4
      }
    };
  }
}
