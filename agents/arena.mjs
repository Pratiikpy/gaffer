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

// ── live loop ────────────────────────────────────────────────────────────────────────────────────────
// Each strategy locks its pick off the live line the first time we see odds, then the match settles by
// the REAL final score (from /api/live once the feed finalises), and PnL accrues. On-chain settlement of
// a staked position is the LATCH kernel's job; this is the strategy engine + auditable scorekeeper.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3000")).replace(/\/$/, "");
const jfetch = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(12_000) }); // every feed call is bounded

const STRATS = ["favorite", "underdog"];

function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `arena-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n"); } catch { /* keep playing */ }
  return line;
}

async function tick(fixtures, book) {
  for (const f of fixtures) {
    const st = book[f];
    if (st.settled) continue;
    try {
      const [o, live] = await Promise.all([
        jfetch(`${BASE}/api/odds/${f}`).then((r) => r.json()),
        jfetch(`${BASE}/api/live?fixture=${f}`).then((r) => r.json()).catch(() => ({})),
      ]);
      // Lock each strategy's pick off the first live line we see.
      if (!st.picks && o?.hasOdds) {
        st.odds = { home: o.home, draw: o.draw, away: o.away };
        st.picks = Object.fromEntries(STRATS.map((s) => [s, pickSide(s, st.odds)]));
        logLine({ fixture: f, action: "picks", odds: st.odds, picks: st.picks });
        console.log(`[PICKS] fixture ${f} · favorite→${st.picks.favorite} · underdog→${st.picks.underdog}`);
      }
      // Settle by the real final score once the feed finalises.
      if (st.picks && live?.finished && live.homeGoals != null) {
        const result = { home: Number(live.homeGoals), away: Number(live.awayGoals) };
        const w = winner(result);
        for (const s of STRATS) {
          const net = settleMatch(s, { odds: st.odds, result });
          st.pnl[s] = Number((st.pnl[s] + net).toFixed(3));
        }
        logLine({ fixture: f, action: "settle", result, winner: w, pnl: st.pnl });
        console.log(`[SETTLE] fixture ${f} · ${result.home}-${result.away} (${w}) · favorite ${st.pnl.favorite >= 0 ? "+" : ""}${st.pnl.favorite}u · underdog ${st.pnl.underdog >= 0 ? "+" : ""}${st.pnl.underdog}u`);
        st.settled = true;
      }
    } catch { /* transient feed error — skip this tick */ }
  }
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const fixtures = process.argv.slice(2).filter((a, i, arr) => !arr.slice(0, i + 1).some((x) => x.startsWith("--"))).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node arena.mjs <fixtureId…> [--interval 60] [--base URL]   |   --selftest"); process.exit(1); }
  const intervalMs = Number(arg("interval", 60)) * 1000;
  const once = process.argv.includes("--once");
  const book = Object.fromEntries(fixtures.map((f) => [f, { picks: null, odds: null, pnl: { favorite: 0, underdog: 0 }, settled: false }]));
  console.log(`Agent-vs-Agent Arena · favorite vs underdog over ${fixtures.join(", ")} · every ${intervalMs / 1000}s → logs/arena-*.jsonl`);
  await tick(fixtures, book);
  if (once) return;
  const timer = setInterval(async () => {
    await tick(fixtures, book);
    if (Object.values(book).every((s) => s.settled)) { clearInterval(timer); console.log("all matches settled — arena complete."); }
  }, intervalMs);
}

// Only run when invoked directly, so the pure functions import side-effect-free into the test suite.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
