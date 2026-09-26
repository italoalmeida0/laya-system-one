// bpe-tokenizer.js - pure-JS BPE tokenizer, zero external dependencies.
// Mirrors models/tokenizer.json: Replace norm + added tokens + Metaspace + BPE.
const MASK = '\u2581';
const SEP = ' ';
const isStripChar = (c) => /\s/.test(c) || c === MASK;

export class BpeTokenizer {
  constructor(json) {
    const model = json.model || {};
    if (model.type !== 'BPE') throw new Error('BpeTokenizer: expected a BPE model');
    if (model.dropout) throw new Error('BpeTokenizer: dropout must be null');
    this.vocab = new Map(Object.entries(model.vocab || {}));
    this.unkToken = model.unk_token ?? '<unk>';
    this.byteFallback = model.byte_fallback === true;
    this.fuseUnk = model.fuse_unk === true;
    this.continuingSubwordPrefix = model.continuing_subword_prefix || null;
    this.endOfWordSuffix = model.end_of_word_suffix || null;

    this.merges = new Map();
    const merges = model.merges || [];
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      const pair = Array.isArray(m) ? m : String(m).split(' ');
      this.merges.set(pair[0] + SEP + pair[1], i);
    }

    // content -> { id, lstrip, rstrip }
    this.addedTokens = new Map();
    for (const t of json.added_tokens || []) {
      this.addedTokens.set(t.content, { id: t.id, lstrip: t.lstrip === true, rstrip: t.rstrip === true });
    }
    this.unkId = this.vocab.get(this.unkToken) ?? this.addedTokens.get(this.unkToken)?.id ?? 3;

    // index added tokens by first char (leftmost-longest matching, fast)
    this.addedIndex = new Map();
    for (const [content, meta] of this.addedTokens) {
      if (!content.length) continue;
      const list = this.addedIndex.get(content[0]) || [];
      list.push({ content, ...meta });
      this.addedIndex.set(content[0], list);
    }
    for (const list of this.addedIndex.values()) {
      list.sort((a, b) => b.content.length - a.content.length);
    }

    this.mask_token = '<mask>';
    this.mask_token_id = this.addedTokens.get('<mask>')?.id ?? 4;
    this.cls_token_id = this.addedTokens.get('<bos>')?.id ?? 2;
    this.sep_token_id = this.addedTokens.get('<eos>')?.id ?? 1;
    this.pad_token_id = this.addedTokens.get('<pad>')?.id ?? 0;
    this.bos_token_id = this.cls_token_id;
    this.eos_token_id = this.sep_token_id;
  }

  tokenId(token) {
    return this.vocab.get(token);
  }

  encode(text, opts = {}) {
    const addSpecialTokens = opts.addSpecialTokens !== false;
    const ids = [];
    for (const piece of this.preTokenize(String(text))) {
      if (piece.addedId !== undefined) {
        this.pushId(ids, piece.addedId);
        continue;
      }
      for (const id of this.encodePiece(piece.text)) this.pushId(ids, id);
    }
    return addSpecialTokens ? [this.bos_token_id, ...ids, this.eos_token_id] : ids;
  }

  /** fuse_unk: collapse consecutive unknown ids into one. */
  pushId(ids, id) {
    if (this.fuseUnk && id === this.unkId && ids.length && ids[ids.length - 1] === this.unkId) return;
    ids.push(id);
  }

  normalize(text) {
    return text.split(' ').join(MASK);
  }

  /** Leftmost-longest match of an added token at `index`, or null. */
  matchAddedToken(text, index) {
    const list = this.addedIndex.get(text[index]);
    if (!list) return null;
    for (const t of list) {
      if (text.startsWith(t.content, index)) return t;
    }
    return null;
  }

  /**
   * Split on the delimiter: each delimiter starts a piece and carries the
   * segment that follows it. A leading segment without a delimiter (a run
   * that did not need the prefix) is kept as its own piece.
   */
  /**
   * Split on the delimiter with MergedWithNext semantics: each delimiter
   * starts a piece and carries the segment that follows it.
   *   "\u2581a\u2581\u2581b" -> ["\u2581a", "\u2581", "\u2581b"]
   */
  splitOnMask(s) {
    const pieces = [];
    let start = -1;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === MASK) {
        if (start >= 0) pieces.push(s.slice(start, k));
        start = k;
      }
    }
    if (start >= 0) pieces.push(s.slice(start));
    else if (s.length) pieces.push(s);
    return pieces;
  }

  preTokenize(rawText) {
    const raw = String(rawText);
    const out = [];
    let runStart = 0;
    let i = 0;

    // Added tokens are matched on the RAW text (before normalization), which
    // is what makes a literal "\u2581\u2581" match while a run of spaces does
    // not. Each plain run is then normalized and metaspaced on its own.
    const flushRun = (endIdx) => {
      if (endIdx <= runStart) return;
      let run = this.normalize(raw.slice(runStart, endIdx));
      if (!run.startsWith(MASK)) run = MASK + run;
      for (const p of this.splitOnMask(run)) out.push({ text: p });
    };

    while (i < raw.length) {
      const m = this.matchAddedToken(raw, i);
      if (!m) {
        i++;
        continue;
      }
      // lstrip/rstrip: the added token swallows the whitespace next to it
      let matchStart = i;
      while (m.lstrip && matchStart > runStart && isStripChar(raw[matchStart - 1])) matchStart--;
      flushRun(matchStart);
      let matchEnd = i + m.content.length;
      while (m.rstrip && matchEnd < raw.length && isStripChar(raw[matchEnd])) matchEnd++;
      out.push({ addedId: m.id });
      i = matchEnd;
      runStart = i;
    }
    flushRun(raw.length);
    return out;
  }

  encodePiece(text) {
    const ids = [];
    {
      for (const symbol of this.bpe(text)) {
        const id = this.tokenId(symbol);
        if (id !== undefined) {
          ids.push(id);
          continue;
        }
        if (this.byteFallback && this.encodeBytes(symbol, ids)) continue;
        this.pushId(ids, this.unkId);
      }
    }
    return ids;
  }

  encodeBytes(symbol, ids) {
    const out = [];
    for (const b of new TextEncoder().encode(symbol)) {
      const tok = `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`;
      const id = this.tokenId(tok);
      if (id === undefined) return false;
      out.push(id);
    }
    for (const id of out) ids.push(id);
    return true;
  }

  /** Standard BPE: merge the lowest-ranked adjacent pair until none apply. */
  bpe(word) {
    let symbols = Array.from(word);
    if (symbols.length < 2) return symbols;
    if (this.continuingSubwordPrefix) {
      symbols = symbols.map((s, i) => (i === 0 ? s : this.continuingSubwordPrefix + s));
    }
    if (this.endOfWordSuffix) {
      symbols = symbols.map((s, i) => (i === symbols.length - 1 ? s + this.endOfWordSuffix : s));
    }
    while (symbols.length > 1) {
      let bestRank = Infinity;
      let bestPair = null;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.merges.get(symbols[i] + SEP + symbols[i + 1]);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPair = [symbols[i], symbols[i + 1]];
        }
      }
      if (bestPair === null) break;
      const merged = bestPair[0] + bestPair[1];
      const next = [];
      for (let i = 0; i < symbols.length; i++) {
        if (i < symbols.length - 1 && symbols[i] === bestPair[0] && symbols[i + 1] === bestPair[1]) {
          next.push(merged);
          i++;
        } else {
          next.push(symbols[i]);
        }
      }
      symbols = next;
    }
    return symbols;
  }

  decode(ids) {
    let out = '';
    for (const id of ids) {
      const token = this.reverseVocab.get(id);
      if (token !== undefined) out += token;
    }
    return out
      .split(MASK).join(' ')
      .replace(/<0x([0-9A-Fa-f]{2})>/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  get reverseVocab() {
    if (!this._reverseVocab) {
      this._reverseVocab = new Map();
      for (const [token, id] of this.vocab) {
        if (!this._reverseVocab.has(id)) this._reverseVocab.set(id, token);
      }
    }
    return this._reverseVocab;
  }
}

/**
 * Wrap a BpeTokenizer in the callable surface the engine expects (same shape
 * the previous HF tokenizer object had):
 *   tok(text, { add_special_tokens }) -> { input_ids: { data: Int32Array } }
 */
export function makeTokenizerCallable(tok) {
  const fn = (text, opts = {}) => {
    const ids = tok.encode(text, { addSpecialTokens: opts.add_special_tokens !== false });
    return { input_ids: { data: Int32Array.from(ids) } };
  };
  fn.mask_token = tok.mask_token;
  fn.mask_token_id = tok.mask_token_id;
  fn.cls_token_id = tok.cls_token_id;
  fn.sep_token_id = tok.sep_token_id;
  fn.pad_token_id = tok.pad_token_id;
  fn.encode = (text, opts) => tok.encode(text, opts);
  fn.decode = (ids) => tok.decode(ids);
  fn._bpe = tok;
  return fn;
}
