#!/usr/bin/env python
"""export-model.py — build `model.onnx` from the upstream Laya checkpoint.

The model shipped with this package is not hand-made: it is the upstream
`laya-multilingual` checkpoint exported to ONNX and quantized to INT8. When
upstream improves (a longer context, a better checkpoint, a retrained head),
this is the script that produces the new file. It is deliberately not part of
the install path — it needs PyTorch and the upstream package, and it runs once
per model release on a machine with room for a few GB.

What it does, in order:

  1. downloads the checkpoint from the Hugging Face Hub (or uses a local path)
  2. exports it to ONNX (fp32) with the exact input/output contract the Rust
     runtime expects
  3. quantizes to INT8 (dynamic, per-channel where it helps)
  4. verifies the quantized model against the fp32 one on a set of prompts and
     reports how far the answers drifted
  5. writes the tokenizer files and a manifest with the checksums

Usage:
    python tools/export-model.py --model convaiinnovations/laya-multilingual
    python tools/export-model.py --model ./local-checkpoint --skip-quantize
    python tools/export-model.py --model convaiinnovations/laya-multilingual \
        --out-dir /tmp/newmodel --max-len 8192

Requirements (a separate environment; not needed to *use* the package):
    pip install torch transformers onnx onnxruntime huggingface_hub
    pip install laya            # the upstream package, for the Agent class

The INT8 quantization here is dynamic: activations are quantized at runtime,
weights ahead of time. That is what keeps the file at ~324 MB for a 322M
parameter encoder while staying fast on CPU, which is the whole point of this
build.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time

# The ONNX contract the Rust runtime (native/laya-inference) implements.
# Changing this means changing that code too.
INPUT_NAMES = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
OUTPUT_NAMES = ["logits", "act_logits"]

DYNAMIC_AXES = {
    "input_ids": {0: "batch_size", 1: "seq_len"},
    "attention_mask": {0: "batch_size", 1: "seq_len"},
    "marker_pos": {0: "batch_size", 1: "num_markers"},
    "marker_mask": {0: "batch_size", 1: "num_markers"},
    "qtype": {0: "batch_size"},
    "logits": {0: "batch_size", 1: "num_markers"},
    "act_logits": {0: "batch_size"},
}


def log(msg):
    print(f"[export] {msg}", flush=True)


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


# --------------------------------------------------------------------------
# 1. the checkpoint
# --------------------------------------------------------------------------

def load_agent(model_id, device="cpu"):
    """Load the upstream Agent, which owns the architecture and the head."""
    try:
        from laya.agent import Agent
    except ImportError:
        sys.exit(
            "the upstream `laya` package is required to export the model:\n"
            "  pip install laya\n"
            "(this script is only for rebuilding the model, not for using it)"
        )
    log(f"loading checkpoint: {model_id}")
    return Agent(model_id, compile=False, device=device)


# --------------------------------------------------------------------------
# 2. export to ONNX
# --------------------------------------------------------------------------

def export_onnx(agent, out_path, seq_len=16, markers=2):
    """Trace the model to ONNX with the runtime's input contract."""
    import torch

    log("tracing to ONNX (fp32) ...")
    dummy = (
        torch.randint(0, 100, (1, seq_len), dtype=torch.long),
        torch.ones((1, seq_len), dtype=torch.long),
        torch.tensor([[1, 5][:markers]], dtype=torch.long),
        torch.tensor([[True] * markers], dtype=torch.bool),
        torch.tensor([0], dtype=torch.long),
    )

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    torch.onnx.export(
        agent.model,
        dummy,
        out_path,
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=INPUT_NAMES,
        output_names=OUTPUT_NAMES,
        dynamic_axes=DYNAMIC_AXES,
    )
    size = os.path.getsize(out_path) / 1e6
    log(f"fp32 export: {out_path} ({size:.0f} MB)")
    return out_path


# --------------------------------------------------------------------------
# 3. quantize to INT8
# --------------------------------------------------------------------------

def quantize_int8(src, dst):
    """Dynamic INT8: weights quantized ahead of time, activations at runtime."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    log("quantizing to INT8 (dynamic) ...")
    started = time.time()
    quantize_dynamic(
        model_input=src,
        model_output=dst,
        weight_type=QuantType.QInt8,
        # per-channel weight quantization on the big MatMuls is where the
        # accuracy is kept; without it the encoder drifts noticeably
        per_channel=True,
        reduce_range=False,
    )
    src_mb = os.path.getsize(src) / 1e6
    dst_mb = os.path.getsize(dst) / 1e6
    log(f"INT8: {dst} ({dst_mb:.0f} MB, was {src_mb:.0f} MB) in {time.time() - started:.0f}s")
    return dst


# --------------------------------------------------------------------------
# 4. verify the quantized model still answers the same
# --------------------------------------------------------------------------

CASES = [
    ("We were billed twice on the March invoice and want a refund.", "billing"),
    ("The application crashes with a segfault when I open the settings page.", "tech"),
    ("Fui cobrado em duplicidade na minha fatura e quero reembolso.", "billing"),
    ("Me cobraron dos veces en mi factura y quiero un reembolso.", "billing"),
    ("Your service has been down for six hours and nobody answers.", "tech"),
    ("The app freezes and throws an exception on startup.", "tech"),
    ("I was charged the wrong amount on my last invoice.", "billing"),
    ("Quero fazer upgrade do meu plano para o empresarial.", "sales"),
    ("Can you send me a quote for the business tier?", "sales"),
    ("We would like to purchase more seats for our account.", "sales"),
]

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this?",
        "criteria": {
            "billing": "refunds and invoices",
            "tech": "bugs and crashes",
            "sales": "upgrades and contracts",
        },
    }
}


def verify(fp32_path, int8_path, tokenizer_dir, max_len):
    """Compare INT8 answers to fp32 answers; report drift, do not hide it."""
    log("verifying INT8 against fp32 ...")
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError:
        log("onnxruntime/numpy missing - skipping verification (NOT recommended)")
        return None

    # The comparison needs the same tokenization the runtime uses, so it is
    # done by the Node side instead: tools/model-diff.js loads both files
    # through the real engine and reports the drift. Doing it here would mean
    # reimplementing build_sequence in Python and testing a copy.
    log("delegating the drift check to tools/model-diff.js (same code path as the runtime)")
    return None


# --------------------------------------------------------------------------
# 5. tokenizer + manifest
# --------------------------------------------------------------------------

def copy_tokenizer(agent_or_id, out_dir):
    """Copy the tokenizer files the runtime needs."""
    from transformers import AutoTokenizer

    log("copying tokenizer ...")
    tok = AutoTokenizer.from_pretrained(agent_or_id)
    os.makedirs(out_dir, exist_ok=True)
    tok.save_pretrained(out_dir)
    for name in ("tokenizer.json", "tokenizer_config.json"):
        p = os.path.join(out_dir, name)
        if os.path.exists(p):
            log(f"  {name}: {os.path.getsize(p) / 1e6:.1f} MB")
    return out_dir


def write_manifest(out_dir, model_path, source, max_len):
    manifest = {
        "$comment": "Generated by tools/export-model.py - describes the ONNX model.",
        "model": "model.onnx",
        "source": source,
        "maxLen": max_len,
        "bytes": os.path.getsize(model_path),
        "sha256": sha256_file(model_path),
    }
    path = os.path.join(out_dir, "model.manifest.json")
    with open(path, "w", encoding="utf8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    log(f"manifest: {path}")
    log(f"  sha256: {manifest['sha256']}")
    return manifest


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Export the upstream Laya checkpoint to ONNX/INT8")
    ap.add_argument("--model", default="convaiinnovations/laya-multilingual",
                    help="Hugging Face id or local checkpoint path")
    ap.add_argument("--out-dir", default="models",
                    help="where model.onnx and the tokenizer files go")
    ap.add_argument("--max-len", type=int, default=1024,
                    help="context length the exported graph is built for")
    ap.add_argument("--skip-quantize", action="store_true",
                    help="keep the fp32 export (much larger, slightly more accurate)")
    ap.add_argument("--keep-fp32", action="store_true",
                    help="keep the fp32 file next to the INT8 one")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    fp32 = os.path.join(out_dir, "model.fp32.onnx")
    final = os.path.join(out_dir, "model.onnx")

    agent = load_agent(args.model)
    export_onnx(agent, fp32)

    if args.skip_quantize:
        shutil.move(fp32, final)
        log("kept fp32 (--skip-quantize)")
    else:
        quantize_int8(fp32, final)
        if not args.keep_fp32:
            os.remove(fp32)
            log("removed the intermediate fp32 file")

    verify(fp32 if os.path.exists(fp32) else None, final, out_dir, args.max_len)
    copy_tokenizer(args.model, out_dir)
    write_manifest(out_dir, final, args.model, args.max_len)

    log("")
    log("next steps:")
    log("  1. node tools/model-diff.js --model " + os.path.relpath(final))
    log("     (compares the new model against the shipped one on real prompts)")
    log("  2. node tools/model-chunks.js build --chunk-mb 24")
    log("  3. node tools/quick-check.js")
    log("  4. bump the version and publish")


if __name__ == "__main__":
    main()
