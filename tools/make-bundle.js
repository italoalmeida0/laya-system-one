#!/usr/bin/env node
// tools/make-bundle.js — packs bin/<plat>-<arch>-musl/{laya-serve,lib/} into ONE
// self-extracting file: bin/<plat>-<arch>-musl/laya-serve.bundle
//
// Layout of the bundle:
//   [loader shell script][\n__PAYLOAD__\n][tar.gz of {laya-serve,lib/}]
// On first run it tries ${TMPDIR:-/dev/shm}/laya/<sha256>/ (RAM,
// invisible) but docker mounts /dev/shm noexec, so the exec-probe fails
// and it falls back to ${XDG_CACHE_HOME:-~/.cache}/laya/<sha256>/
// (validated: alpine:3.20 docker uses disk cache, inference OK).
// Reuses the cache on later runs
// (verified by .ok marker), sets LD_LIBRARY_PATH to the extracted lib/
// and execs the real binary. Result: user sees ONE file, zero loose .so
// files, zero system deps beyond musl itself.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const LOADER = `#!/bin/sh
# laya-serve self-extracting bundle (musl). No system deps beyond musl.
set -e
BUNDLE="$0"
MARK=$(grep -a -n -m1 '^__PAYLOAD__$' "$BUNDLE" | cut -d: -f1)
# NOTE: busybox grep on Alpine matches ^...$ per line even with -a; the
# first hit is inside this loader script itself (line 5), so skip it.
# The real payload marker is the LAST occurrence.
MARK=$(grep -a -n '^__PAYLOAD__$' "$BUNDLE" | tail -n 1 | cut -d: -f1)
# Extract to RAM (/dev/shm: invisible, ~0.2s, gone on reboot) with
# fallback to disk cache (~/.cache) when shm is missing, tiny or ro.
# $TMPDIR override supported (e.g. TMPDIR=/var/tmp for big containers).
H=$(sha256sum "$BUNDLE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$BUNDLE" | cut -d' ' -f1)
try_extract() {
  rm -rf "$1"; mkdir -p "$1" 2>/dev/null || return 1
  tail -n +$((MARK + 1)) "$BUNDLE" | tar -xz -C "$1" 2>/dev/null || return 1
  chmod +x "$1/laya-serve" 2>/dev/null
  # probe exec: /dev/shm is noexec on docker default -> fall back to disk.
  # (probe runs the binary's --help: needs its libs too, so export first)
  LDD_PATH="$1/lib:$LD_LIBRARY_PATH"
  LD_LIBRARY_PATH="$LDD_PATH" "$1/laya-serve" --help >/dev/null 2>&1 || return 1
  touch "$1/.ok" 2>/dev/null || return 1
  return 0
}
DEST=""
for BASE in "\${TMPDIR:-/dev/shm}/laya" "\${XDG_CACHE_HOME:-$HOME/.cache}/laya"; do
  CAND="$BASE/$H"
  if [ -f "$CAND/.ok" ]; then DEST="$CAND"; break; fi
  if try_extract "$CAND"; then DEST="$CAND"; break; fi
done
if [ -z "$DEST" ]; then echo "laya-serve: cannot extract bundle" >&2; exit 1; fi
export LD_LIBRARY_PATH="$DEST/lib:\${LD_LIBRARY_PATH:-}"
exec "$DEST/laya-serve" "$@"
__PAYLOAD__
`;

function bundleOne(dir) {
  const srcDir = path.join(root, 'dist', 'bin', dir);
  const bin = path.join(srcDir, 'laya-serve');
  const lib = path.join(srcDir, 'lib');
  if (!fs.existsSync(bin) || !fs.existsSync(lib)) {
    console.log(`skip ${dir}: no musl layout`);
    return;
  }
  const out = path.join(srcDir, 'laya-serve.bundle');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layabundle-'));
  // stage payload: laya-serve + lib/ at tar root
  fs.copyFileSync(bin, path.join(tmp, 'laya-serve'));
  execFileSync('tar', ['-czf', path.join(tmp, 'payload.tgz'), '-C', srcDir, 'laya-serve', 'lib']);
  const payload = fs.readFileSync(path.join(tmp, 'payload.tgz'));
  // Binary-safe concat: LOADER is \n-only (no CRLF mangling through git
  // or writeFileSync), payload appended as raw bytes.
  const loaderBuf = Buffer.from(LOADER.replace(/\r\n/g, '\n'), 'utf8');
  fs.writeFileSync(out, Buffer.concat([loaderBuf, payload]));
  fs.chmodSync(out, 0o755);
  const hash = createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 12);
  console.log(`${dir}: bundle ${(fs.statSync(out).size / 1048576).toFixed(1)}MB sha=${hash}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const dirs = process.argv.slice(2);
(bundleOne.length >= 0) && (dirs.length ? dirs : ['linux-x64-musl', 'linux-arm64-musl']).forEach(bundleOne);
