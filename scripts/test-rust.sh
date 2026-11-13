#!/usr/bin/env bash
# Runs the pure Rust rules shared by the contract (contracts/barrel-core).
# Same linker choice as build-contract.sh: some machines have a `cc` first on
# PATH that cannot link host binaries, so prefer the system compiler.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
if [ -z "${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER:-}" ] && [ -x /usr/bin/gcc ]; then
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/gcc
fi
cargo test -p barrel-core
