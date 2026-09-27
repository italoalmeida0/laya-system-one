# BUILD.md — reproducing every `laya-serve` binary from scratch

All commands assume the repo root unless noted. Toolchain versions used:
Rust 1.98, zig 0.16.0, `cargo-zigbuild` 0.23.4, ORT 1.28 (via `ort-sys`
`download-binaries`, fetched automatically at build time).

## 0. One-time setup

```bash
rustup target add \
  x86_64-pc-windows-msvc \
  x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
  x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
  aarch64-apple-darwin
cargo install cargo-zigbuild
# Windows-ARM64 native builds need clang-cl + llvm-lib in PATH (VS 2022).
```

## 1. Windows (native, on Windows)

```bash
cd native/laya-serve
cargo build --release                                   # -> win32-arm64
cargo build --release --target x86_64-pc-windows-msvc   # -> win32-x64
cp target/release/laya-serve.exe ../../dist/bin/win32-arm64/
cp target/x86_64-pc-windows-msvc/release/laya-serve.exe ../../dist/bin/win32-x64/
```

## 2. Linux gnu (in WSL2 Ubuntu)

```bash
# aarch64: native
cd ~/serve-build   # copy of native/laya-serve
cargo build --release
# x86_64 cross: needs the real GNU linker (zig-ld CANNOT link ORT's
# libstdc++ objects: undefined std::__throw_length_error etc.)
sudo apt-get install -y g++-x86-64-linux-gnu
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
  cargo build --release --target x86_64-unknown-linux-gnu
```

## 3. Linux musl (in WSL2 Ubuntu)

```bash
# a) ORT .so: ort-sys ships NO musl prebuilt. Use the PyPI wheel .so
#    (glibc-linked, x86_64) or the Alpine apk .so (musl-native):
pip download --no-deps --platform manylinux_2_27_x86_64 \
  --python-version 312 --only-binary=:all: -d /tmp/ortx64 onnxruntime
unzip -o -j /tmp/ortx64/*.whl 'onnxruntime/capi/libonnxruntime.so*' -d ort-musl/
# b) linker-script trick: ort-sys emits `-lonnxruntime` which the cross ld
#    can't resolve (it looks in a phantom rustcXXX/raw-dylibs dir).
#    Satisfy it with a fake static archive pointing at the .so:
echo 'INPUT(/abs/path/ort-musl/libonnxruntime.so)' > ort-musl/libonnxruntime.a
# c) build (x86_64 example; aarch64 needs its own .so in ort-musl-a64/):
ORT_LIB_PATH=$PWD/ort-musl ORT_PREFER_DYNAMIC_LINK=1 \
RUSTFLAGS='-C linker=x86_64-linux-gnu-gcc -C target-feature=-crt-static \
  -C link-arg=-lm -C link-arg=-ldl -C link-arg=-lpthread' \
  cargo build --release --target x86_64-unknown-linux-musl
# d) BETTER: cargo zigbuild handles musl interp correctly:
ORT_LIB_PATH=$PWD/ort-musl ORT_PREFER_DYNAMIC_LINK=1 \
  cargo zigbuild --release --target x86_64-unknown-linux-musl
#    -> interp is /lib/ld-musl-x86_64.so.1 (verify: readelf -p .interp)
# e) bundle with libs: node tools/make-bundle.js
#    (packs laya-serve + lib/ into laya-serve.bundle self-extracting)
```

> NOTE: the PyPI `.so` is glibc-linked and can NEVER load on Alpine
> (`__vsnprintf_chk not found`, validated in docker even with `gcompat`).
> For a musl bundle that runs on pure Alpine, extract the `.so` set from
> the Alpine apk instead (`apk add onnxruntime ...` on alpine:edge, copy
> `/usr/lib/libonnxruntime.so*` + protobuf/re2/abseil/icu/libstdc++).
> See `dist/bin/linux-x64-musl/lib/` layout (63 files, `libonnxruntime.so.1`
> SONAME link required).

## 4. macOS arm64 cross (from Linux, zig — no Xcode)

```bash
# a) stubs live in-repo: native/laya-serve/zig-darwin/
#    (Foundation.tbd, CoreML.tbd, libobjc.tbd, libiconv.tbd — link-time
#    only; real libs exist on every Mac) + apple-stubs/stubs.c (24 ObjC
#    symbols ORT's CoreML EP references; CPU path never calls them).
# b) wrapper sets CC/LINKER + AR (zig ar! GNU ar output breaks lld:
#    "unknown cpu architecture"):
export CC_aarch64_apple_darwin="$PWD/native/laya-serve/zigcc-darwin.sh"
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$PWD/native/laya-serve/zigcc-darwin.sh"
export AR_aarch64_apple_darwin='zig ar'
export RUSTFLAGS="-C link-arg=-L$PWD/native/laya-serve/zig-darwin -C link-arg=-lobjc"
cargo build --release --target aarch64-apple-darwin
# c) also required in Cargo.toml: tokenizers WITHOUT onig
#    (onig_sys compiles C -> breaks cross):
#    tokenizers = { version = "0.22", default-features = false,
#                   features = ["fancy-regex"] }
#    (our tokenizer.json needs no regex: Metaspace + BPE only)
#    + build-dependencies: cc = "1" (for apple-stubs on apple targets)
```

## 5. wasm (browser)

```bash
rustup target add wasm32-unknown-unknown
# needs wasm-pack
cd native/laya-inference
wasm-pack build --target web --out-dir ../../src/wasm-pkg --features wasm
# wasm32 rustflags (+simd128,+bulk-memory) live in .cargo/config.toml
```

## 6. Bundle + verify

```bash
node tools/make-bundle.js            # (re)builds linux-*-musl/*.bundle
node bin/postinstall.js              # restores exec bits
npm run test:all                     # lint + unit + packaging + integration + e2e
npm run test:install                 # pack + install into a clean dir + run
node tools/compare-all.js --trials 2 # full benchmark matrix (needs docker for linux)
```

## 7. CI

Two workflows, with a deliberate split: CI builds and proves things, the
developer's machine checks and publishes.

| workflow | trigger | what it does |
|---|---|---|
| `build-packages.yml` | tag `v*`, manual | builds the binary for each platform on a native runner (plus the musl bundles in Alpine), cuts the model into 13 chunk packages, proves every binary answers 10 questions, and uploads the finished packages as artifacts |
| `verify-published.yml` | manual | installs a **published** version from the real registry on linux glibc/musl (x64 + arm64), Windows (x64 + arm64) and macOS (arm64 + x64), in Node and Bun, and runs a real inference; refuses to pass if the binary came from anywhere but `node_modules` |

Build a specific version on purpose:

```bash
gh workflow run build-packages.yml -f version=1.1.0-alpha.1
```

The version is stamped into `package.json`, the lockfile, the manifest and
every `@sys-one/*` pin before anything is built, so nothing can disagree.

Everything that is a developer concern rather than a build concern stays
local, where it is faster and free:

```bash
npm run check          # lint, unit, packaging, integration, e2e,
                       # build the packages, and a full install rehearsal
npm run check:quick    # the same minus the model-backed suites (~2 min)
npm run test:rehearsal # install from a LOCAL registry and use it, Node + Bun
```

The rehearsal is the one that matters before publishing: it serves the freshly
built packages from an in-process npm registry, installs the entry package
into a throwaway project, and asserts that npm selected exactly the expected
platform package, that the 13 model chunks arrived, that the binary is
executable, and that 10 questions come back with the right answers.

## 8. Model asset distribution (the 324 MB problem)

npm rejects payloads over ~200 MB (HTTP 413), so `model.onnx` cannot ship
inside the package. It is split into chunk packages that live on npm:

```bash
npm run model:chunks       # split models/model.onnx -> dist/model-chunks/<pkg>/
                           # writes models/model.manifest.json (sha256 per chunk)
npm run model:assemble     # reassemble from the chunks (byte-identical)
npm run model:verify       # checksum against the manifest
npm run model:publish      # publish the chunk packages (npm login first)
npm run model:test-registry# round-trip through the registry tarballs
```

`src/model-resolver.js` then rebuilds `model.onnx` on the user's machine:
`LAYA_MODEL_PATH` → local file → verified cache → chunk packages in
`node_modules` → npm registry tarballs → GitHub Releases, with sha256
verification and atomic writes on every step.

Chunk size is 24 MB (13 packages for this model): small enough for any
registry mirror/proxy, large enough to keep the request count low.
Bump `--model-version` whenever the checkpoint changes — the chunk
packages are immutable by content.
