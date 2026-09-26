#!/bin/sh
# Runs INSIDE the Alpine container (see .github/workflows/ci.yml).
#
# The musl binary must be built and run on real musl with the musl-native
# onnxruntime libs - the PyPI .so is glibc-linked and can never load on Alpine
# (see BUILD.md). The onnxruntime package only exists on the Alpine edge
# branch, so the repositories point there.
set -eux

echo 'https://dl-cdn.alpinelinux.org/alpine/edge/main' > /etc/apk/repositories
echo 'https://dl-cdn.alpinelinux.org/alpine/edge/community' >> /etc/apk/repositories
cat /etc/apk/repositories

apk add --no-cache nodejs npm build-base rust cargo git curl python3 onnxruntime onnxruntime-dev

echo "--- musl runtime ---"
ls /lib/ld-musl* || true
ls -la /usr/lib/libonnxruntime* || true

TRIPLE="$1"

echo "--- build laya-serve (musl) ---"
export ORT_LIB_PATH=/usr/lib
export ORT_PREFER_DYNAMIC_LINK=1
cargo build --release --target "$TRIPLE" --manifest-path native/laya-serve/Cargo.toml

BIN="$PWD/native/laya-serve/target/$TRIPLE/release/laya-serve"
chmod +x "$BIN"
file "$BIN" || true
export LAYA_SERVE_BIN="$BIN"

echo "--- install + test ---"
npm ci
npm run model:acquire
npm run test:integration
npm run test:e2e
node tools/bench.js --backend native --questions 5 --json bench-native.json