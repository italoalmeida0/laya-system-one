# Changelog

All notable changes to `laya-system-one` are documented here.

## [1.1.0] — 2026-09-26

### Removed: all external runtime dependencies

The package now ships everything it needs and downloads nothing but the
model. `dependencies` is empty.

- **`onnxruntime-node` / `onnxruntime-web` are gone.** The only backends are
  the bundled self-contained `laya-serve` binary (`native`, default) and the
  bundled pure-Rust `tract` wasm engine (`wasm`). The `ort` backend was
  removed from the API/CLI (`--backend native|wasm`).
- **`@huggingface/transformers` is gone.** Tokenization is now a pure-JS BPE
  implementation (`src/bpe-tokenizer.js`) that reproduces the
  `tokenizer.json` pipeline exactly: the `Replace` normalizer, the
  `Metaspace` pre-tokenizer (`prepend_scheme: always`), the added-vocabulary
  pass (including the whitespace-run tokens and `<mask>`'s `lstrip`) and the
  580k-merge BPE model with byte fallback and `fuse_unk`.
  - Verified **token-for-token** against the reference `tokenizers` crate
    binding — the same version the native binary links — over a 95-case
    corpus (`tests/fixtures/tokenizer-golden.json`,
    `npm run tokenizer:diff`). Both backends therefore see identical input
    ids, which is what makes them agree on answers.
  - `src/_sharp_stub.cjs` (a shim for `transformers`' optional `sharp`
    dependency) was deleted with it.

### Changed
- `Laya.load()` documents and enforces the two backends; an unknown
  `backend` is now a clear error instead of silently falling through.
- Install is much lighter: no postinstall binary downloads, no ORT/transformers.

Release focus: **deterministic installs, honest docs, and a test suite that
actually exercises the system.** The wire protocol is unchanged.

### Added

- **Model distribution over npm.** The 324 MB checkpoint no longer depends on
  git or a single download source. `tools/model-chunks.js` splits it into 13
  npm chunk packages (`laya-system-one-model-chunk-00` … `-12`, ~24 MB each)
  and `src/model-resolver.js` reassembles them locally.
- **Deterministic model acquisition** (`src/model-resolver.js`):
  `LAYA_MODEL_PATH` → local file → verified cache → local chunk packages →
  npm registry tarballs → GitHub Releases. Every copy is sha256-verified
  against `models/model.manifest.json` and written atomically (temp file +
  rename), with retries and backoff on every network fetch.
- **Test suite** (`node:test`, zero new dependencies):
  `tests/unit` (decision math, prompt building, HTTP protocol, resolver,
  chunk pipeline), `tests/integration` (real model: determinism, native↔ort
  agreement, multilingual), `tests/e2e` (wire contract, CLI, lifecycle),
  `tests/packaging` (npm pack contents and size budget) and
  `tests/fresh-install` (pack → install into a clean dir → run).
- **CI/CD**: `.github/workflows/ci.yml` (OS × Node matrix, model-backed
  integration job, packaging job with size budget) and `release.yml`
  (builds native binaries and model chunks on tag).
- `npm run lint`: syntax, packaging and documentation-consistency gate
  (fails the build if the README repeats claims that are known to be false).
- `Laya.health()` and `Laya.close()`, `serve()` now returns `laya` and a
  `close()` that releases everything it owns.
- CLI: `--version`, `--backend`, graceful SIGINT/SIGTERM shutdown.

### Fixed

- **Process never exited after `serve()`**: the spawned `laya-serve` child
  process was never terminated, keeping the Node event loop alive forever.
  `close()` now releases the engine it created.
- **The engine could steal the public port.** `serve()` forwarded the same
  `host`/`port` to the internal `laya-serve`, and on Windows two sockets *can*
  bind one address (SO_REUSEADDR) — requests reached the wrong server and
  shutdown looked broken. The engine now always binds a private loopback port
  (it is no longer exposed externally either).
- **Empty question maps behaved differently per backend**: `ort`/`wasm`
  returned `answers: {}`, `native` returned 422. All backends now answer with
  an empty result.
- **`server.close()` hung** on keep-alive sockets (undici pools them);
  idle/all connections are now closed explicitly.
- **`serve({ port: 0 })` was ignored** (`||` treated `0` as unset) and the
  returned URL reported port `0` instead of the bound port.
- `LayaEngine.close()` referenced `this.wasm` instead of `this.wasmPool`, so
  wasm workers were never released.
- `options.modelPath` was dropped when the model resolver was introduced —
  honoured again (highest priority).
- Postinstall no longer hard-fails an install; the model is fetched lazily on
  first use (`LAYA_PREFETCH_MODEL=1` to prefetch at install time).
- `tools/benchmark-gpu.js` used `import.meta.url.pathname`, which breaks on
  Windows paths.

### Changed

- **README rewritten to match reality.** The 1.0.0 README claimed the model
  was "embedded directly within the package", advertised WebGPU as an
  accelerator and quoted unverified latency numbers. The model is acquired at
  runtime, the native binary is the fast path, and WebGPU is not used
  server-side (measured slower than native CPU).
- `buildAnswer()` exported from `src/agent.js` — the decision math is now a
  pure, unit-tested function.
- Package metadata: `engines.node >= 18.17`, `files` whitelist tightened.

### Migration from 1.0.0

The `/v1/systemone` wire protocol is unchanged. See "Migrating from 1.0.0" in
the README for the Node API differences.

## [1.0.0] — 2026-09-23

Initial release (ONNX Runtime only, model embedded, single question per call).
