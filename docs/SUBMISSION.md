# GAFFER — TxLINE Hackathon Submission

**Live app:** https://gaffer-cyan.vercel.app (no sign-up, no install — you're playing in seconds)
**Repo:** this repository · **Chain:** Solana devnet · **Data:** TxLINE / TxODDS live World Cup feeds

---

## Core idea

Most fans watch the World Cup with a phone in their hand — and the game they *actually* play is in the group chat: "USA to score?", "does that goal stand?", "next goal's mine." GAFFER makes that game real, and it does the one thing every existing app can't: **the moment the match proves you right, you're paid — from a pool with no house in it, and it can show you the receipt.**

It's a **skill-and-social game** running on **valueless devnet play-coins** (a free faucet, not a purchase) — so nothing of value is wagered. What's being demonstrated is the *payout technology*: instant, non-custodial, un-clawback, and provable, on live TxLINE data.

Three surfaces, one loop:
1. **The call → the payout.** Back a parimutuel pool ("USA to score?"). When TxLINE's data proves it, the pool self-settles on-chain and pays the winners pro-rata. One tap collects; a **Proof-of-Payout** receipt shows the amount, the odds you called it at, and an on-chain proof link.
2. **The Frozen Window.** The minute every sportsbook *locks* its doors — a VAR review — our round *opens*. A real goal event in the TxLINE feed auto-triggers a synchronized "does it stand?" flash round; the room fills live; it settles on the real goal-count delta and pushes your whole squad.
3. **The Gaffer's Take.** An AI pundit reacts to real feed moments (goal / card / VAR verdict) with a one-line hot take and one-tap voice.

## How TxLINE powers the backend

TxLINE isn't a garnish — it's the settlement substrate. Nothing pays out without it.

- **The schedule spine.** `GET /api/fixtures/snapshot` drives the whole app's "Today" — the real 104-game World Cup calendar with team names, kickoff and competition, so every surface reads "USA v Bosnia," never a hardcode.
- **The live match.** `GET /api/scores/historical/{fixtureId}` (SSE stream) and `GET /api/scores/snapshot/{fixtureId}` feed the Match Centre timeline, the pool questions, and — critically — the **goal-count that settles the Frozen Window** and **auto-triggers** it when a goal lands live.
- **The crowd's belief.** `GET /api/odds/snapshot/{fixtureId}?asOf=` gives the de-margined consensus 1X2 line that becomes the Frozen Window's live "sweat" strip.
- **The proof — the whole point.** `GET /api/scores/stat-validation?fixtureId&seq&statKey` returns the Merkle-proof bundle that our on-chain kernel feeds into TxODDS's **`validate_stat`** program via CPI. `validate_stat` re-verifies that bundle against the oracle's anchored `daily_scores_roots` and returns a bool verdict. **Our program physically cannot pay the wrong side** — it never decides the outcome; it reads TxLINE's verdict. That's what makes a trustless, no-house payout possible.
- **Auth:** `POST /auth/guest/start` → guest JWT; an on-chain `subscribe` to the TxODDS program → `POST /api/token/activate` → the API token (held server-side; it never touches the browser).

## Technical highlights

- **LATCH kernel** (Anchor / Solana, `HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG`): non-custodial parimutuel pools + N-leg parlays, self-settling via the `validate_stat` CPI. `lock_ts` closes the oracle-latency exploit (no call lands after the cut-off). **39/39 on the devnet test suite** — pro-rata payout to the lamport, refunds, parlay sweeps/busts, every settlement-binding negative, and the rake.
- **Permissionless, repeatable settlement.** Settle is a permissionless crank — the kernel re-verifies the proof, so anyone can settle and no one can settle wrongly. The app keeps a fresh, open demo pool alive on-demand so **every** visitor reaches the PAID moment, not just the first.
- **A real commercial floor.** A capped-5%, currently-0, winnings-only protocol rake lives in an on-chain config PDA; the app's fee line reads the live number straight from chain — a verifiable revenue switch, not a slide.
- **Server-authoritative game layer.** Points/streaks/squads on Postgres; money grants verified to the exact on-chain instruction discriminator; per-user token guard.
- **Consumer-grade shell.** Next.js 16 installable PWA, web push (VAPID, fans a squad out the instant the Frozen Window opens), dynamic Proof-of-Payout / brand OG images, 18+ gate, responsible-play (mute-money) and watch-along (spoiler-safe) modes. Zero crypto jargon anywhere a fan reads.

## Business / monetization path

Parimutuel **rake** (0–5%, on winnings only, capped in-program) is the primary line — turned on with zero redeploy. Around it: **power plays** (premium slips, boosts), **private squads/leagues**, and sponsored **Frozen Window** rounds. The kernel generalizes to any competition TxLINE carries, so the World Cup is season one, not the whole business.

## Your experience with the TxLINE API — what we liked, where we hit friction

**Liked most:**
- The **single normalized JSON schema** across scores/odds/fixtures genuinely let us scale from one fixture to the whole tournament with no per-competition special-casing.
- `validate_stat` **returning a bool via return-data** is elegant — it lets our kernel stay dumb-and-safe and simply read the verdict, and it's what makes trustless on-chain settlement of sports outcomes actually buildable. This is rare and excellent.
- **Anchored Merkle roots** (`daily_scores_roots`) mean the data is provable on-chain, not just fetched — the foundation the entire product stands on.
- The **historical SSE stream** is easy to parse and gave us goals/cards/corners/chances without a separate events API.

**Friction (specific, and hopefully useful):**
1. **Stale host.** `oracle-dev.txodds.com` was dead; the working host is `txline-dev.txodds.com`. A few references still point at the old one — cost us time early.
2. **Token activation is under-documented.** The `guest/start → on-chain subscribe → api/token/activate` flow needs a wallet-signed `"{txSig}::{jwt}"` message; a single worked end-to-end example would have saved an afternoon.
3. **Proof→CPI mapping.** The `stat-validation` bundle shape (`summary` / `statToProve` / `eventStatRoot` / `statProof` / `subTreeProof` / `mainTreeProof`, each node `{hash, isRightSibling}`) had to be reverse-engineered against the on-chain IDL to feed `validate_stat`. A documented "bundle field → `validate_stat` argument" table would be the single highest-value doc addition.
4. **ms vs seconds footgun.** The `validate_stat` seed `ts` is `summary.minTimestamp` in **milliseconds**, while on-chain expiry is UNIX **seconds**. Undocumented; easy to get wrong.
5. **`period` semantics.** The proof's `period` is the live game-phase at the snapshot, not the stat scope — so a market must bind by **stat key only**. Confirming this safely took experimentation; worth a doc note.
6. **Odds `Pct` = "NA"** on quarter lines needs client filtering — a note in the odds docs would help.
7. **Compute.** `validate_stat` over a real soccer proof fits ~400k CU but needed a ComputeBudget bump; expected-CU-per-proof-depth guidance would prevent surprise failures.
8. **Historical stream size.** A finished match is 1000+ events; a seq-range / paginated fetch would cut bandwidth for apps that only need recent moments.

## Endpoints used (quick list)

`POST /auth/guest/start` · `POST /api/token/activate` · `GET /api/fixtures/snapshot` · `GET /api/scores/snapshot/{fixtureId}` · `GET /api/scores/historical/{fixtureId}` · `GET /api/odds/snapshot/{fixtureId}` · `GET /api/scores/stat-validation` · on-chain `validate_stat` CPI + `daily_scores_roots` (TxODDS program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`).
