import { loadTokenizer, buildSequence, QTYPES } from './tokenizer.js';
import { LayaEngine } from './engine.js';

/**
 * Validate one question definition (TypeSafe Jev wire contract).
 *
 * Shared by every backend so a payload is accepted or rejected the same way
 * whether it is evaluated by the native binary, onnxruntime or wasm.
 *
 * @returns {string} the resolved question type (defaults to 'choice')
 */
export function validateQuestionDef(qid, qdef) {
  if (!qdef || typeof qdef !== 'object') {
    throw new Error(`Question '${qid}' must be an object.`);
  }
  const qtype = qdef.type || 'choice';
  if (!(qtype in QTYPES)) {
    throw new Error(`Unsupported question type '${qtype}' for question '${qid}'. Must be 'choice', 'score', or 'noul'.`);
  }
  return qtype;
}

/** Validate a whole question map (rejects non-object maps too). */
export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('questions must be an object map of question definitions');
  }
  for (const [qid, qdef] of Object.entries(questions)) {
    validateQuestionDef(qid, qdef);
  }
  return Object.keys(questions);
}

/**
 * Compute calibrated confidence score from probability distribution.
 * Normalized between 0.0 and 1.0.
 */
export function confidenceFromProbs(probs, k) {
  if (k <= 1) return 1.0;
  const pMax = Math.max(...probs);
  const conf = (pMax - 1.0 / k) / (1.0 - 1.0 / k);
  return Math.min(1.0, Math.max(0.0, conf));
}

/**
 * Numerically stable softmax with temperature scaling.
 */
export function softmax(arr, temperature = 1.0) {
  const scaled = arr.map(x => x / Math.max(0.01, temperature));
  const max = Math.max(...scaled);
  const exp = scaled.map(x => Math.exp(x - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(x => x / sum);
}

/**
 * Decode one question's raw logits into its public answer object.
 *
 * Pure function (no model, no I/O) so it can be unit-tested exhaustively:
 * the decision math is the part of the pipeline that must never drift.
 *
 * @param {object} item   { qid, q: {t, ins, crit}, qdef, qtype, markers, logits }
 * @param {object} config engine config ({ temperature: [t_choice, t_score, t_noul] })
 * @returns {object} answer object matching the TypeSafe Jev schema
 */
export function buildAnswer(item, config = {}) {
  const { q, qdef } = item;
  const k = item.markers.length;
  const rowLogits = item.logits.slice(0, k);

  const qt = item.qtype;
  const temp = (config.temperature && config.temperature[qt]) || 1.0;
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

    return {
      type: 'choice',
      choice: keys[maxIdx],
      probabilities: probMap,
      confidence: conf
    };
  }

  if (q.t === 'score') {
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

    return {
      type: 'score',
      score: Number(expectedScore.toFixed(4)),
      legend,
      probabilities: probMap,
      confidence: conf
    };
  }

  // noul (calibrated yes/no score)
  const pTrue = probs[1] !== undefined ? probs[1] : 0.0;
  const noulVal = Number(pTrue.toFixed(4));
  const ans = {
    type: 'noul',
    noul: noulVal,
    confidence: Number(Math.max(pTrue, 1.0 - pTrue).toFixed(4))
  };
  if (qdef?.threshold !== undefined && qdef?.threshold !== null) {
    ans.threshold = Number(qdef.threshold);
    ans.decision = noulVal >= ans.threshold;
  }
  return ans;
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
   * Load the model and tokenizer.
   * @param {Object} options
   *   backend: 'native' (default) | 'wasm'  (or env LAYA_BACKEND)
   *   modelDir, host, port, apiKey, threads, wasmWorkers
   *
   * Backends (nothing else is used, no external runtime):
   *   'native' - the bundled self-contained laya-serve binary (Axum +
   *              tokenizers + ONNX Runtime, statically linked). Fastest.
   *   'wasm'   - the bundled pure-Rust tract wasm engine (browser-safe).
   */
  static async load(options = {}) {
    const backend = options.backend || process.env.LAYA_BACKEND || 'native';
    if (backend === 'native') {
      const { NativeServer } = await import('./laya-native.js');
      const srv = new NativeServer({
        modelDir: options.modelDir,
        host: options.host,
        port: options.port,
        apiKey: options.apiKey,
        threads: options.threads,
      });
      await srv.start();
      return new LayaNative(srv, options);
    }
    if (backend !== 'wasm') {
      throw new Error(`Unknown backend '${backend}'. Use 'native' or 'wasm'.`);
    }
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
  async predict(state, questions = {}, requestedModel = null, options = {}) {
    const qids = Object.keys(questions);
    const modelName = requestedModel || 'laya-multilingual';

    if (qids.length === 0) {
      return {
        model: modelName,
        answers: {},
        usage: { input_tokens: 0, output_tokens: 0 }
      };
    }

    // maxLen cap: the Bun napi bridge degrades on seqLen >= 64 (~1300ms
    // vs ~70ms) while Node handles any length fine. Cap sequence length
    // on Bun to 63 (plenty for choice/score/noul prompts) unless the user
    // overrides via options.maxLen / LAYA_MAX_LEN. Node keeps config max.
    const isBunRt = typeof Bun !== 'undefined';
    const envMax = parseInt(process.env.LAYA_MAX_LEN || '', 10);
    const defaultMax = this.config.max_len || 1024;
    const maxLen = options?.maxLen || (Number.isFinite(envMax) && envMax > 0 ? envMax : (isBunRt ? Math.min(defaultMax, 63) : defaultMax));
    const headMaxLen = this.config.head_max_len || 256;
    const items = [];
    let totalInputTokens = 0;

    for (const qid of qids) {
      const qdef = questions[qid];
      const qtype = validateQuestionDef(qid, qdef);

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
      const item = { ...items[r], logits: allLogits[r] };
      answers[item.qid] = buildAnswer(item, this.config);
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

  /** Health probe (same shape as GET /health). */
  async health() {
    return {
      status: 'ok',
      model: 'laya-multilingual',
      backend: this.engine?.wasmPool ? 'wasm' : 'native'
    };
  }

  /** Release engine resources (sessions, wasm workers). */
  async close() {
    if (this.engine && typeof this.engine.close === 'function') {
      await this.engine.close();
    }
  }
}

/**
 * LayaNative: same predict() API, backed by the spawned laya-serve binary.
 * The binary does tokenize -> infer -> decode; JS only proxies HTTP.
 */
export class LayaNative {
  constructor(server, options = {}) {
    this.server = server;
    this.model = options.model || 'laya-multilingual';
  }

  static async load(options = {}) {
    const { NativeServer } = await import('./laya-native.js');
    const srv = new NativeServer({
      modelDir: options.modelDir,
      host: options.host,
      port: options.port,
      apiKey: options.apiKey,
      threads: options.threads,
    });
    await srv.start();
    return new LayaNative(srv, options);
  }

  async predict(state, questions = {}, requestedModel = null) {
    const modelName = requestedModel || this.model;
    // Validate exactly like Laya.predict does: the wire contract must not
    // depend on which backend is behind it (laya-serve has its own, slightly
    // different schema checks).
    validateQuestions(questions);
    const qids = Object.keys(questions);
    if (qids.length === 0) {
      // laya-serve rejects empty question maps with 422 while the JS engine
      // answers with an empty result. Normalize here.
      return { model: modelName, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    }
    // laya-serve requires `type` on every question, the JS engine defaults it
    // to 'choice'. Fill it in so the payload is interpreted identically.
    const normalized = Object.fromEntries(
      qids.map((qid) => [qid, questions[qid].type ? questions[qid] : { ...questions[qid], type: 'choice' }])
    );
    return this.server.predict(state, normalized, modelName);
  }

  async health() {
    return this.server.health();
  }

  async close() {
    await this.server.stop();
  }
}
