# GAFFER — architecture & verified facts

How the pieces fit, and the hard facts the build depends on (each verified against the live devnet program and the TxLINE API).

## The stack

```
 Fan (Next.js PWA)
   │  calls signed in-browser by the player's own wallet (dev keypair or Privy embedded)
   ▼
 LATCH kernel (Solana, Anchor 0.31)  ──CPI──►  TxLINE validate_stat  ──►  daily_scores_roots
   │  create_market → join_pool → settle → claim        (returns a verified bool verdict)
   │  create_parlay → join_parlay → settle_leg → resolve_parlay → claim_parlay
   ▼
 Keeper (autonomous)  discovers the anchored proof for an open pool and settles it, no human in the loop.

 Next.js API  ──►  Postgres (Neon)     server-authoritative points ledger, squads, streaks
             ──►  TxLINE (server-side) scores + consensus-odds streams; credentials never reach the browser
```

## The LATCH kernel

A non-custodial parimutuel engine. Funds live in a per-market vault PDA the program owns; no operator can move them outside the settlement rules.

- **Single markets:** `create_market` opens a monotone over-threshold predicate on one soccer stat. `join_pool` stakes YES/NO into the vault. `settle` proves the predicate via a CPI into TxLINE `validate_stat` and, on a `true` verdict, marks the winning side. `claim` pays the winning side pro-rata (`pot × your_stake / winning_total`). `void` refunds both sides if a market can't resolve.
- **Parlays:** `create_parlay` (up to 8 legs, all-or-nothing), `join_parlay`, `settle_leg` (each leg proven independently), `resolve_parlay` (busts to NO after expiry + grace), `claim_parlay`.
- **`lock_ts` (the anti-exploit gate):** every market and parlay carries a lock timestamp; `join_pool`/`join_parlay` reject any stake at or after it. This closes the oracle-latency exploit — you cannot stake the known-winning side after the TV shows the event but before the anchor catches up. Period markets lock at period start; flash rounds lock seconds after opening.
- **Fund safety:** an empty winning side routes to a full refund (`VOID`) rather than locking the pot; the void path has a grace window so a within-window YES can't be denied at the boundary.

## TxLINE integration (verified)

- Devnet host: **`txline-dev.txodds.com`**. Auth is a guest JWT → on-chain `subscribe` → activated API token (kept server-side only).
- **`validate_stat` returns a bool** via return-data, read with `get_return_data`; the kernel only pays on `true` (and is safe if the program reverts instead). Its seed `ts` is the summary's `min_timestamp`.
- Markets bind the **stat key** (which already encodes scope, e.g. full-match vs first-half) and the **fixture id**; a proof's `period` is the live game-phase at the snapshot, not the stat scope. Single-stat only — no caller-supplied binary expression can inflate a value.
- Roots anchor in ~300s batches (`daily_scores_roots` for scores, `daily_batch_roots` for odds). "Instant" honestly means: the verdict lands in seconds off the feed; a staked payout lands inside the next anchor window.
- Data surfaces used: scores SSE + historical replay, the consensus-odds snapshot/stream, and stat-validation. Eight soccer stat keys (goals / yellow / red / corners, per participant).

## Program IDs (devnet)

| | Address |
|---|---|
| LATCH kernel | `HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG` |
| TxLINE oracle | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |

Settlement is devnet-only today; the kernel is chain-agnostic and moves to mainnet the moment TxLINE settlement is available there.

## Server-authoritative points

Points are an idempotent event ledger (`points_events`); a user's total is `SUM(amount)` — the client can never post a total. Free grants are deduped per UTC day and guarded by a per-user token. Money grants (stake / win) are verified on-chain **down to the exact instruction**: a win grant requires a real `claim`/`claim_parlay` instruction signed by that wallet, a stake grant a real `join`. A `join` signature can never mint a win.

## Test & verification

- `npm run test:kernel` — 32-case devnet suite: pro-rata payout to the lamport, empty-side→VOID refund, `void()` both-sides refund, parlay YES sweep, parlay bust→NO, `lock_ts` late-call rejection, and every settlement-binding negative.
- `npm run e2e:kernel` / `e2e:parlay` — full stake→settle→claim, single-market and parlay.
- `npm run keeper` — the autonomous settler.
