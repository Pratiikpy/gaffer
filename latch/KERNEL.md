# LATCH — the settlement kernel

An Anchor program (Solana) that runs **trustless parimutuel prediction markets and N-leg parlays**, and
settles them by a **Cross-Program Invocation into TxLINE's `validate_stat`** — so verification and payout
happen in one atomic transaction, decided by cryptographically-anchored World Cup data, with no operator,
oracle vote, or house in the path.

- **Program ID (devnet):** `HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG`
- **TxLINE oracle (CPI target):** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- **Anchor** 0.31.1 · **Solana** 4.0.2. `cargo check -p latch` passes clean.

## Why it's different (LATCH vs the field)

Every other on-chain sports-settlement design trusts *something*: Monaco/BetDEX settle on an **operator
signature**; Hxro/Drift read a **price**; Polymarket/UMA wait for a **bonded human vote** (2h liveness,
disputes, a token-holder jury). LATCH's `settle` **is the verification** — it CPIs into `validate_stat`
over a Merkle-anchored proof and pays out in the same instruction. No signer, no price, no jury, no delay.

## Instruction set (12)

**Config**
- `init_config(fee_recipient, rake_bps)` — one-time; sets the house-fee recipient and rake (hard-capped).
- `set_rake(rake_bps, fee_recipient?)` — authority-only; rake changes are bounded by `BadRake`.

**Single market lifecycle**
- `create_market(...)` — opens a parimutuel pool over one soccer stat predicate (monotone over-threshold),
  with a `lock_ts` cut-off (KILL-1 anti-latency) and an `expiry_ts` window.
- `join_pool(side, amount)` — stake YES/NO; rejected after `lock_ts` (`PoolLocked`).
- `settle(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, …)` — **the core**: pins the
  txoracle program *and* owner-pins the roots account (H5), binds the proof to this market's `fixture_id`
  and `stat_key`, forbids caller-supplied binary expressions, requires `ts ≤ expiry`, then CPIs
  `validate_stat` and reads the bool verdict via return-data. Pays only on `true`.
- `void()` — refund path when a side is empty / the match is abandoned.
- `claim()` — winner (or refund) withdraws their pro-rata share; idempotent (`AlreadyClaimed`).

**Parlay lifecycle** (all legs must land)
- `create_parlay(parlay_id, fixture_id, legs, lock_ts, expiry_ts)` · `join_parlay(side, amount)` ·
  `settle_leg(...)` (per-leg proof) · `resolve_parlay()` (all-legs-proven → outcome) · `claim_parlay()`.

## Account model

- **Config** — fee recipient, rake bps, authority.
- **Market** — fixture_id, stat_key, threshold, comparison, status, lock_ts, expiry_ts, yes/no totals, winning_side.
- **Position** — per (market, owner, side): staked amount + claimed flag (claim-flag-before-transfer).
- **Parlay / Leg** — the multi-leg equivalent; each Leg carries its own stat predicate + proven flag.

Vaults are non-custodial PDAs (`vault`/`pvault`); the program is the only signer that can move staked funds,
and only toward winners or refunds.

## Security guards (mapped to the error codes)

- **Oracle integrity:** `BadOracleProgram` pins the CPI target **and** owner-pins the roots account so a
  forged roots account can't be supplied (H5).
- **Proof binding:** `FixtureMismatch` / `StatMismatch` / `BinaryNotAllowed` — a proof can only settle the
  exact market it belongs to; no cross-fixture or inflated-value settlement.
- **Window:** `Expired` (proof after expiry) · `PoolLocked` / `BadLock` (no calls after the cut-off, the
  anti-oracle-latency guard) · `NotExpired` (can't force-close early).
- **Payout correctness:** `PredicateNotMet` / `NoVerdict` (pay only on a true verdict) · `NotWinner` /
  `NotResolved` · `AlreadyClaimed` (idempotent claims) · `Overflow` (checked math) · `BadFeeRecipient`
  (claim pins the fee recipient to Config).

Full list: 23 named `KernelError` variants, one per failure path — no `unwrap`-into-panic, every revert
carries a message the client maps to fan copy.

## Determinism & funds-safety properties

- Settlement is a pure function of (market predicate, anchored proof) — same inputs, same outcome, no
  discretionary input.
- Rake is bps-integer and hard-capped in the code; taken from winnings only, never the stake.
- Every fund-moving path can only route toward a winner or a refund; there is no operator withdrawal.

## Build & test

- **Compiles clean:** `cd latch && cargo check -p latch` (exit 0).
- **Proven on devnet e2e:** the TS harness in `../src/` drives the real program — `kernel-e2e.ts`
  (create → stake two wallets → settle on a real anchored proof → claim, pot drained to 0) and
  `parlay-e2e.ts` (2-leg parlay settled + claimed). `phase0.ts` gates the `validate_stat` CPI + compute.
- **Still owed for a best-in-class repo:** a
  scenario-numbered LiteSVM/Mollusk suite + a Trident fuzz target (no surveyed competitor ships fuzzing —
  a cheap differentiator), and the permissionless inactivity-invalidate (dead-resolver → anyone voids →
  refunds) from Hedgehog's parimutuel.
