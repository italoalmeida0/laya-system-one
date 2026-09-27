#!/bin/sh
# alpine-verify.sh — install the published package on real Alpine and use it.
#
# Runs INSIDE the alpine container (see verify-published.yml). It lives in a
# file rather than inline in the workflow because the work needs three levels
# of quoting - YAML, the host shell, and the container shell - and nesting
# them produced unterminated strings twice.
#
# Env:
#   VERSION  the published version to install (e.g. 1.1.0-alpha.1)
#   ARCH     x64 or arm64
set -eu

echo "--- musl runtime ---"
ls /lib/ld-musl* || true

apk add --no-cache nodejs npm curl bash unzip

mkdir -p /verify && cd /verify
npm init -y >/dev/null
npm install "laya-system-one@$VERSION" --no-audit --no-fund

echo "--- installed @sys-one packages ---"
ls node_modules/@sys-one/ | sort

# Exactly the musl package for this arch, and nothing else specific: the whole
# point of the os/cpu split is that one machine gets one binary.
SPECIFIC=$(ls node_modules/@sys-one/ | grep '^laya-serve-' | grep -v universal || true)
echo "specific package: $SPECIFIC"
if [ "$SPECIFIC" != "laya-serve-linux-$ARCH" ]; then
  echo "expected laya-serve-linux-$ARCH, got $SPECIFIC"
  exit 1
fi

# The musl build ships as a self-extracting bundle (binary + libs in one file).
BUNDLE="node_modules/@sys-one/laya-serve-linux-$ARCH/bin/linux-$ARCH-musl/laya-serve.bundle"
if [ ! -f "$BUNDLE" ]; then
  echo "no musl bundle at $BUNDLE"
  find node_modules/@sys-one -type f | head -20
  exit 1
fi
chmod +x "$BUNDLE"
echo "--- bundle runs on bare Alpine ---"
"$BUNDLE" --help 2>&1 | head -3

# --- run it, with Node -----------------------------------------------------
cat > check.mjs <<'JS'
import { Laya } from 'laya-system-one';
const q = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    criteria: { billing: 'refunds and invoices', tech: 'bugs and crashes', sales: 'upgrades and contracts' }
  }
};
const cases = [
  ['We were billed twice on the March invoice and want a refund.', 'billing'],
  ['The application crashes with a segfault when I open the settings page.', 'tech'],
  ['Quero fazer upgrade do meu plano para o empresarial.', 'sales'],
  ['Me cobraron dos veces en mi factura y quiero un reembolso.', 'billing'],
  ['The app freezes and throws an exception on startup.', 'tech']
];
const t0 = Date.now();
const laya = await Laya.load({ backend: 'native' });
const loadMs = Date.now() - t0;
let pass = 0;
for (const [prompt, want] of cases) {
  const got = (await laya.predict(prompt, q)).answers.department.choice;
  if (got === want) pass++;
  else console.log('  mismatch', JSON.stringify({ prompt, want, got }));
}
await laya.close();
console.log(`correct: ${pass}/${cases.length} (load ${loadMs}ms)`);
if (pass < cases.length - 1) process.exit(1);
JS

echo "--- Node on musl ---"
node check.mjs

# --- and with Bun ----------------------------------------------------------
echo "--- Bun on musl ---"
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"
bun --version
bun check.mjs

echo "MUSL VERIFIED ($ARCH)"
