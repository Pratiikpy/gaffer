#!/usr/bin/env node
/**
 * Agent-vs-Agent Arena — Track 3. Two agents read the same TxLINE-derived 1X2 odds and run OPPOSITE
 * strategies (favorite vs underdog); each match settles by the real result and PnL accrues over the
 * tournament. Deterministic core (`runArena`) so the competition is auditable and backtestable. In the
 * full product each position settles on-chain through the LATCH kernel (see ../latch/KERNEL.md); this
 * tool is the strategy engine + scorekeeper. `node arena.mjs --selftest` verifies the logic.
 */

/** Which side a strategy backs, from 1X2 implied % (home/away only; draw is skipped for a binary bet). */
export function pickSide(strategy, odds) {
  const backHome = odds.home >= odds.away;
  return strategy === "favorite" ? (backHome ? "home" : "away") : (backHome ? "away" : "home");
}

/** Match winner from the real final score. */
export function winner(result) {
  return result.home > result.away ? "home" : result.home < result.away ? "away" : "draw";
}

/** Net units on a 1-unit stake at fair (de-margined) odds: win → 1/p − 1, lose → −1. Deterministic. */
export function settleMatch(strategy, match) {
  const pick = pickSide(strategy, match.odds);
  const p = Math.min(0.99, Math.max(0.01, (match.odds[pick] ?? 50) / 100));
  return winner(match.result) === pick ? 1 / p - 1 : -1;
}

/** Run both agents over a list of {odds:{home,draw,away}, result:{home,away}} matches. */
export function runArena(matches, strategies = ["favorite", "underdog"]) {
  const pnl = Object.fromEntries(strategies.map((s) => [s, 0]));
  const record = Object.fromEntries(strategies.map((s) => [s, { w: 0, l: 0 }]));
  for (const m of matches) for (const s of strategies) {
    const net = settleMatch(s, m);
    pnl[s] += net;
    if (net > 0) record[s].w++; else record[s].l++;
  }
  const lead = strategies.reduce((a, b) => (pnl[a] >= pnl[b] ? a : b));
  return { pnl: Object.fromEntries(strategies.map((s) => [s, Number(pnl[s].toFixed(3))])), record, lead };
}

function selftest() {
  // Favorites win 3 of 4; the "favorite" agent should end ahead of "underdog".
  const matches = [
    { odds: { home: 60, draw: 25, away: 15 }, result: { home: 2, away: 0 } }, // fav (home) wins
    { odds: { home: 30, draw: 30, away: 40 }, result: { home: 0, away: 1 } }, // fav (away) wins
    { odds: { home: 55, draw: 25, away: 20 }, result: { home: 3, away: 1 } }, // fav (home) wins
    { odds: { home: 45, draw: 25, away: 30 }, result: { home: 0, away: 2 } }, // underdog (away) wins
  ];
  const r = runArena(matches);
  const ok = r.lead === "favorite" && r.pnl.favorite > r.pnl.underdog && r.record.favorite.w === 3;
  console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify(r));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else console.log("Agent-vs-Agent Arena · import { runArena } or run with --selftest. Live wiring settles on-chain via ../latch (RPC-gated).");
