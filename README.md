<div align="center">

# GAFFER

### The World Cup, turned into a game you play with your mates — and the payout is one no one can refuse.

**[▶ Play it live — gaffer-cyan.vercel.app](https://gaffer-cyan.vercel.app)** · _demo video: filmed during a live knockout match, linked here on submission_

Call what happens on the pitch, together, in real time. Win, and the pot pays you the moment the match proves you right — from a pool with no house in it, so no one can void it, limit you, or stall your payout. Ever.

Built on [TxLINE](https://txodds.com) live World Cup data and settled on Solana.

</div>

---

## The idea in 30 seconds

Every sports app makes you a customer of a house that profits when you lose — and the top complaint across the entire category isn't the odds, it's *"they won't pay me."* Trustpilot scores of 1.3–1.9★ sit next to 4.5★ App Store ratings for the same apps. The gap is the whole opportunity.

GAFFER removes the house entirely. Calls go into a **parimutuel pool**: everyone who's right splits the pot in proportion to their stake, and the result itself releases the money — verified against official match data, on-chain, with no operator in the loop who *can* refuse you. You feel it as: *you called it → you got paid → here's the proof.*

No jargon, no seed phrases, no token. It should feel like your group chat got a scoreboard and a wallet.

## Play it in 60 seconds

1. Open **[gaffer-cyan.vercel.app](https://gaffer-cyan.vercel.app)** — no sign-up, no install.
2. **Today** → lock in the free daily call (your streak starts).
3. **Cash → Add funds** — tops up your in-app balance with **free devnet play-coins** (a faucet, not a purchase).
4. Back a pool (*"USA to score?"*), watch the projected payout move as others take the other side.
5. **Cash → Your calls → Collect** — the pool settles on the real result and pays you out, with a Proof-of-Payout receipt.
6. **Live → The Freeze** → the signature synchronized round that opens the minute every sportsbook locks its doors.

> **On money:** GAFFER runs today on **valueless devnet play-currency** — it's a free-to-play skill-and-social game, not real-money wagering. The innovation being demonstrated is the *payout technology*: instant, non-custodial, un-clawback, and provable. The path to real-money rails is real, but nothing of value is staked in this build.

## What's in the box

| Layer | What it is |
|---|---|
| **LATCH kernel** | An Anchor (Solana) program: non-custodial parimutuel pools + N-leg parlays, settled by a CPI into TxLINE's on-chain `validate_stat`. Pays the winning side pro-rata; refunds automatically if a match is called off. **`lock_ts` closes the oracle-latency exploit** — no call can land after the cut-off. |
| **Commercial floor** | A capped (5%), currently-**0** protocol rake on winnings-only, living in a singleton on-chain config PDA. The app's fee line and revenue screen read the live number straight from chain — a verifiable, flip-a-switch revenue path, not a slide. |
| **The Frozen Window** | The signature real-time round. During a live match a **real goal event auto-opens** a synchronized "goal under review — does it stand?" flash round: 20s to call, the room fills live, a Verdict Brief on settle, and a web-push ping to your whole squad the same second. Settles on the real goal-count delta. |
| **The Receipt** | Every win fires a Proof-of-Payout card stamped with the odds you called it at (e.g. "Called at 23% · paid 2.50×"), a buried on-chain proof link, and a shareable branded OG image. |
| **The Gaffer's Take** | An AI pundit (NVIDIA NIM) that reacts to real TxLINE feed moments — goal, red card, VAR verdict — with a one-line hot take and one-tap voice (browser TTS). Never blank: templated fallback if the model is slow. |
| **Keeper** | An autonomous crank that discovers the anchored proof for an open pool and settles it with no human in the loop. Settlement is permissionless — the kernel re-verifies the proof, so anyone can crank and no one can settle a pool wrongly. |
| **Web app** | Next.js 16 **installable PWA** — Today / Live / Slip / Squad / Nations / Cash / You. Server-authoritative points on Postgres, browser-signed on-chain calls, web push (VAPID), 18+ gate, mute-money + spoiler-safe modes, felt-not-shown copy throughout. |
| **Data** | TxLINE live scores + consensus-odds + fixture streams, proxied server-side so credentials never touch the browser. |

### Architecture

```
 Fan (PWA)  ──calls, signed in-browser──►  LATCH kernel (Solana)  ──CPI──►  TxLINE validate_stat
     │                                            ▲                              (official match data,
     │  points / squads / streaks                 │  settle / claim               anchored on-chain)
     ▼                                            │
 Next.js API ──► Postgres (server-authoritative)  Keeper (autonomous settle)
```

## Proof it works

- **Kernel test suite: 39/39 passing on devnet** — pro-rata payout to the lamport, empty-side→refund, `void()` both-sides refund, parlay all-legs-hit sweep, parlay bust→NO, `lock_ts` late-call rejection, the **capped rake** (exact fee split + cap + authority guards), and every settlement-binding negative (fixture/stat/binary/expiry/comparison). Run: `npx ts-node src/kernel-tests.ts`.
- **The full stake → settle → PAID loop, proven on-chain** — a fresh wallet stakes YES on a finished, anchored fixture, the pool settles permissionlessly on the real TxLINE proof (`provenValue: 2`), and the claim pays out a profit — receipt signature on Explorer.
- **The Frozen Window, load-tested** — 24 concurrent callers into one round, zero failures, correct tally, settled on the real goal-count delta.
- **Deployed and playable** at the live URL above, backed by hosted Postgres and a dedicated RPC.

## Run it yourself

**Kernel + scripts** (`/`, Node + ts-node):
```bash
npm install
npm run test:kernel     # 32-case devnet suite (needs ~2 devnet SOL on .devnet-key.json)
npm run e2e:kernel      # single-market stake → settle → claim, end to end
npm run keeper          # autonomous settler loop
```

**Web app** (`/web`, Next.js 16):
```bash
cd web
cp .env.example .env.local   # fill DATABASE_URL, GAFFER_KEYPAIR_SECRET, RPC
npm install
npm run dev                  # http://localhost:3000
```

## On-chain facts

- **LATCH program (devnet):** `HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG`
- **TxLINE oracle (devnet):** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` — `validate_stat` returns a verified verdict the kernel reads before it pays.
- Devnet throughout today; the kernel is chain-agnostic and flips to mainnet the moment TxLINE settlement is live there.

## Where it's going

Real-money rails (fiat on-ramp, felt-like-Venmo cash-out), Telegram mini-app + Farcaster frame on the same backend, the synchronized-squad live rounds ("the minute every sportsbook locks its doors, our round starts"), and season-two beyond the World Cup — the kernel generalizes to any competition TxLINE carries.

## License

[MIT](./LICENSE).
