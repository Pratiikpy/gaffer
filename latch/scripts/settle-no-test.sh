#!/bin/bash
# Prove settle_no pays the NO side, against the real oracle and a real anchored proof.
#
# The two program binaries are dumped from devnet rather than committed; the proof bundle and the
# oracle's anchored `daily_scores_roots` account are checked in, because they are small and they are the
# evidence. On Windows this runs in Docker: solana-secp256r1-program pulls OpenSSL, which wants an
# MSVC-native perl.
set -euo pipefail
cd "$(dirname "$0")/.."
FIX=programs/latch/tests/fixtures

[ -f "$FIX/latch.so" ]    || cp target/deploy/latch.so "$FIX/latch.so"
[ -f "$FIX/txoracle.so" ] || solana program dump 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J "$FIX/txoracle.so" --url devnet

if [ "${OS:-}" = "Windows_NT" ]; then
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cd .. && pwd)/latch":/work -w /work \
    -e SBF_OUT_DIR=/work/$FIX -e CARGO_TARGET_DIR=/tmp/target \
    -e PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    rust:1-bookworm bash -c "cargo test -p latch --test settle_no -- --nocapture"
else
  SBF_OUT_DIR="$PWD/$FIX" cargo test -p latch --test settle_no -- --nocapture
fi
