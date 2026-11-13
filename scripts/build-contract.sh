#!/usr/bin/env bash
# Builds contracts/barrel to res/barrel.wasm and the testnet faucet token to
# res/test_usdc.wasm.
#
# Uses cargo-near when it is installed (the standard NEAR build, which also
# embeds the ABI and runs wasm-opt). Otherwise falls back to plain cargo with
# the same compiler flags cargo-near sets: `--cfg near` selects near-sdk's
# on-chain host-function path, and `-C link-arg=-s` strips the binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts/barrel"

# Some machines have a non-system `cc` first on PATH that cannot link host
# build scripts. Prefer the system compiler when it exists.
if [ -z "${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER:-}" ] && [ -x /usr/bin/gcc ]; then
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/gcc
fi

mkdir -p "$ROOT/res"
if command -v cargo-near >/dev/null 2>&1 && [ "${BARREL_PLAIN_CARGO:-0}" != "1" ]; then
  cargo near build non-reproducible-wasm --out-dir "$ROOT/res"
  (cd ../test-usdc && cargo near build non-reproducible-wasm --out-dir "$ROOT/res")
else
  RUSTFLAGS='-C link-arg=-s --cfg near' \
    cargo build -p barrel -p test-usdc --target wasm32-unknown-unknown --release
  cp ../target/wasm32-unknown-unknown/release/barrel.wasm "$ROOT/res/barrel.wasm"
  cp ../target/wasm32-unknown-unknown/release/test_usdc.wasm "$ROOT/res/test_usdc.wasm"
fi
ls -l "$ROOT"/res/*.wasm
sha256sum "$ROOT"/res/*.wasm
