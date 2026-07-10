#!/bin/bash
# The integration suite: the kernel driven against the REAL TxODDS oracle.
#
#   settle_no  — a NO backer is paid the pot when the goal never came
#   rake       — the revenue switch: the house takes its basis points, only from a winner
#
# Nothing is mocked. `txoracle.so` is the binary dumped from devnet; `roots.bin` is that program's own
# anchored `daily_scores_roots` account; the proofs are genuine `stat-validation` responses for fixture
# 18172379 (USA 2-0 Bosnia). The clock is ours, which is the only thing devnet cannot give us: a market
# must be opened before the snapshot that settles it, and every snapshot in the feed is in the past.
#
# On Windows this runs in Docker: solana-secp256r1-program pulls OpenSSL, which wants an MSVC-native perl.
set -euo pipefail
cd "$(dirname "$0")/.."
FIX=programs/latch/tests/fixtures

[ -f "$FIX/latch.so" ]    || cp target/deploy/latch.so "$FIX/latch.so"
[ -f "$FIX/txoracle.so" ] || solana program dump 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J "$FIX/txoracle.so" --url devnet

TESTS="--test settle_no --test rake"

if [ "${OS:-}" = "Windows_NT" ]; then
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(cd .. && pwd)/latch":/work -w /work \
    -e SBF_OUT_DIR=/work/$FIX -e CARGO_TARGET_DIR=/tmp/target \
    -e PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    rust:1-bookworm bash -c "cargo test -p latch $TESTS -- --nocapture"
else
  SBF_OUT_DIR="$PWD/$FIX" cargo test -p latch $TESTS -- --nocapture
fi
