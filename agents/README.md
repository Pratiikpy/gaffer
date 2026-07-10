# GAFFER Agents — Track 3 (Trading Tools & Agents)

Autonomous tools on the live TxLINE World Cup feed. Each has a **deterministic core** (pure function,
self-testable) so a professional desk can audit and backtest the logic — the track's bar is "could a
trading team deploy this," and deterministic + auditable is how you clear it.

Odds come from the GAFFER odds route (`/api/odds/[fixtureId]`), which proxies the signed TxLINE feed
server-side (de-margined 1X2 implied %). Run the web app first (`cd ../web && npm run dev`), then the agents.

## The fleet

| Agent | File | What it does | Verify |
|---|---|---|---|
| **Sharp Movement Detector** | `detector.mjs` | Polls 1X2 implied % every 60s, flags line moves ≥ threshold, timestamps each signal | `node detector.mjs --selftest` → PASS · `node detector.mjs 18202783` (live) |
| **Agent-vs-Agent Arena** | `arena.mjs` | Two agents run opposite strategies (favorite vs underdog) over the same odds, settle on real results, accrue PnL + W/L. Full wiring settles each position on-chain via the LATCH kernel (`../latch`) | `node arena.mjs --selftest` → PASS |
| **In-Play Market Maker** | `market-maker.mjs` | Quotes bid/ask around fair, PULLS quotes on a decisive event (goal/red/VAR/penalty) — the risk gate that's the real MM failure mode | `node market-maker.mjs --selftest` → PASS |
| **AI Pundit** | `../web/src/app/api/pundit/route.ts` | Reacts to a real TxLINE moment with a one-line opinionated take; never-blank templated fallback; LLM-backed (NIM; 0G key available) | `curl -X POST /api/pundit -d '{"kind":"goal",...}'` → a line |
| **Keeper** (settler) | `../src/keeper.ts` | Autonomous: discovers an anchored proof unaided and pays the winner via the kernel | proven on devnet |

## The edge (why TxLINE + on-chain)

Incumbents sell trust; these sell **proof**. The detector's signals are timestamped on the same signed
feed the kernel settles on; the arena's positions settle on-chain (no "trust my backtest"); nobody in the
surveyed field ships deterministic, auditable, on-chain-settled agents on institutional-grade odds data.

## TxLINE endpoints used

- `oddsSnapshot(fixtureId)` → de-margined 1X2 `Pct` (implied %) — the detector, arena, market-maker.
- `historicalEvents(fixtureId)` → the event stream (goals/cards/VAR) — the pundit + the MM event gate.
- `validate_stat` (CPI, via the LATCH kernel) → trustless settlement of arena positions.
