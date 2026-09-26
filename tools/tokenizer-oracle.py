#!/usr/bin/env python
"""tokenizer-oracle.py - ground truth for the pure-JS BPE tokenizer.

Runs the reference implementation (the `tokenizers` crate binding, the same
version the native laya-serve binary links) over a corpus and prints the
token ids as JSON. tools/tokenizer-diff.js compares the JS implementation
against this output.

  python tools/tokenizer-oracle.py [models/tokenizer.json]
"""
import json
import sys

from tokenizers import Tokenizer

path = sys.argv[1] if len(sys.argv) > 1 else 'models/tokenizer.json'
tk = Tokenizer.from_file(path)

corpus = json.load(sys.stdin)
out = []
for text, add_special in corpus:
    ids = tk.encode(text, add_special_tokens=add_special).ids
    out.append(list(ids))
json.dump(out, sys.stdout)
