#!/bin/bash
# zigcc-darwin.sh — C linker wrapper for darwin cross builds.
# Strips the --target=arm64-apple-macosx flag cargo/cc-rs injects
# (zig uses -target aarch64-macos instead) and adds the stub .tbd
# framework search paths.
# Usage (WSL2/Linux): export CC_aarch64_apple_darwin="$PWD/zigcc-darwin.sh"
#   CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$PWD/zigcc-darwin.sh"
# Requires: zig in PATH, native/laya-serve/zig-darwin/ stubs present.
# Set ZIG_DARWIN_STUBS to override the stubs dir (default: relative
# zig-darwin/ next to this script).
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STUBS="${ZIG_DARWIN_STUBS:-$SCRIPT_DIR/zig-darwin}"
args=()
for a in "$@"; do
  case "$a" in --target=*) ;; *) args+=("$a");; esac
done
exec zig cc -target aarch64-macos -F "$STUBS/Frameworks" -L "$STUBS" "${args[@]}"
