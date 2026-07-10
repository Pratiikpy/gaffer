#!/bin/bash
# Upgrade the LATCH kernel the moment the deploy buffer can be afforded.
#
# `settle_no` is written, tested (14 kernel + 26 app assertions) and merged, but a Solana program upgrade
# needs ~3.3 SOL of transient rent for the deploy buffer — refunded the instant the upgrade lands. The
# devnet faucet rate-limits per IP, so this waits, retries the airdrop, and deploys unattended.
set -u
ROOT=/c/Users/prate/gaffer
KEY="$ROOT/.devnet-key.json"
ADDR=Eubd72SuAMGvxZGgt2DjdNUrBPYyoUM2diWbbKViDXhr
PROG=HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG
SO="$ROOT/latch/target/deploy/latch.so"
NEED=3.45
LOG="$ROOT/logs/deploy-settle-no.log"

say() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$LOG"; }

while true; do
  BAL=$(solana balance "$ADDR" --url devnet 2>/dev/null | awk '{print $1}')
  if [ -n "${BAL:-}" ] && awk "BEGIN{exit !($BAL >= $NEED)}"; then
    say "funded ($BAL SOL) — deploying settle_no"
    if solana program deploy "$SO" --program-id "$PROG" --url devnet --keypair "$KEY" >>"$LOG" 2>&1; then
      say "DEPLOYED. balance now $(solana balance $ADDR --url devnet)"
      exit 0
    fi
    say "deploy failed; will retry"
  else
    solana airdrop 2 "$ADDR" --url devnet --keypair "$KEY" >/dev/null 2>&1 && say "airdrop landed -> $(solana balance $ADDR --url devnet)"
  fi
  sleep 120
done
