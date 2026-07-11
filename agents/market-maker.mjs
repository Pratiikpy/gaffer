#!/usr/bin/env node
/**
 * In-Play Market Maker — Track 3. Quotes a two-sided market (bid/ask) on an in-play outcome from
 * TxLINE's de-margined implied %, and — critically — PULLS its quotes the instant a decisive event
 * lands (goal / red / VAR / penalty) until it reprices, because the #1 reported MM-bot failure mode is
 * inventory/risk management, not signal (r/algobetting, 46pt thread). Deterministic pricing so a desk
 * can audit the spread. `node market-maker.mjs --selftest`.
 */

/** Fair probability (0.01–0.99) from an implied %. */
export function fairPrice(impliedPct) {
  return Math.min(0.99, Math.max(0.01, (impliedPct ?? 50) / 100));
}

/** Symmetric two-sided quote around fair, widened by `spreadBps`. */
export function quote(impliedPct, { spreadBps = 400 } = {}) {
  const fair = fairPrice(impliedPct);
  const half = spreadBps / 10000 / 2;
  return {
    fair: Number(fair.toFixed(4)),
    bid: Number(Math.max(0.01, fair - half).toFixed(4)),
    ask: Number(Math.min(0.99, fair + half).toFixed(4)),
    spreadBps,
  };
}

/** Event-aware risk gate: pull quotes (null) on a decisive event; hold otherwise. This is the survive-
 *  the-snipers rule — a stale quote across a goal is how in-play MMs get picked off. */
export function onEvent(kind) {
  return ["goal", "red", "var", "penalty"].includes(String(kind)) ? null : "hold";
}

/** A decisive event, read from the ODDS rather than an event feed. The TxLINE dev feed does not stream
 *  live score events (verified: `historical` stays empty and `snapshot` reads "scheduled" for the whole
 *  match), so a market maker cannot subscribe to "goal". But a goal/red/VAR is exactly what moves the
 *  de-margined line hard and fast — so a jump of `threshold`+ implied-% points across a tick IS the
 *  decisive event, and pulling on it is the same risk discipline `onEvent` encodes, driven by the one
 *  live signal the feed actually provides. Same inputs → same output, so a desk can audit it. */
export function decisiveMove(prev, next, threshold = 6) {
  if (!prev || !next) return null;
  let best = null;
  for (const k of ["home", "draw", "away"]) {
    const move = Math.abs((next[k] ?? 0) - (prev[k] ?? 0));
    if (move >= threshold && (!best || move > best.move)) best = { side: k, from: prev[k], to: next[k], move };
  }
  return best;
}

function selftest() {
  const q = quote(40, { spreadBps: 400 });
  const spreadOk = q.bid < q.fair && q.fair < q.ask && Math.round((q.ask - q.bid) * 10000) === 400;
  const clampOk = quote(1).bid >= 0.01 && quote(99).ask <= 0.99;
  const pullOnGoal = onEvent("goal") === null;
  const holdOnThrowIn = onEvent("throw_in") === "hold";
  const pullOnJump = decisiveMove({ home: 40, draw: 30, away: 30 }, { home: 52, draw: 24, away: 24 }, 6)?.side === "home";
  const holdOnDrift = decisiveMove({ home: 40, draw: 30, away: 30 }, { home: 42, draw: 29, away: 29 }, 6) === null;
  const ok = spreadOk && clampOk && pullOnGoal && holdOnThrowIn && pullOnJump && holdOnDrift;
  console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify({ q, pullOnJump, holdOnDrift }));
  process.exit(ok ? 0 : 1);
}

// ── live loop ────────────────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3000")).replace(/\/$/, "");
const jfetch = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(12_000) }); // every feed call is bounded

const PULL_PTS = Number(process.env.PULL_THRESHOLD || arg("pull", 6));   // implied-% jump that pulls quotes
const SPREAD_BPS = Number(process.env.SPREAD_BPS || arg("spread", 400));

function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `market-maker-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n"); } catch { /* keep quoting */ }
  return line;
}

async function tick(fixtures, state) {
  for (const f of fixtures) {
    try {
      const o = await jfetch(`${BASE}/api/odds/${f}`).then((r) => r.json());
      if (!o?.hasOdds) continue;
      const now = { home: o.home, draw: o.draw, away: o.away };
      const shock = decisiveMove(state[f], now, PULL_PTS);
      if (shock) {
        // Decisive move → pull, exactly as onEvent("goal") would. Reprice off the new line next tick.
        logLine({ fixture: f, action: "pull", reason: `${shock.side} ${shock.from}%→${shock.to}% (${shock.move}pt)` });
        console.log(`[PULL] fixture ${f} · ${shock.side} moved ${shock.move}pt — quotes down, repricing`);
      } else {
        const q = quote(now.home, { spreadBps: SPREAD_BPS });
        logLine({ fixture: f, action: "quote", home: now.home, ...q });
        console.log(`[QUOTE] fixture ${f} · home ${now.home}% · bid ${q.bid} / ask ${q.ask} (fair ${q.fair})`);
      }
      state[f] = now;
    } catch { /* transient feed error — skip this tick, hold last state */ }
  }
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const fixtures = process.argv.slice(2).filter((a, i, arr) => !arr.slice(0, i + 1).some((x) => x.startsWith("--"))).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node market-maker.mjs <fixtureId…> [--interval 30] [--once] [--base URL]   |   --selftest"); process.exit(1); }
  const intervalMs = Number(arg("interval", 30)) * 1000;
  const once = process.argv.includes("--once");
  const state = {};
  console.log(`In-Play Market Maker · quoting ${fixtures.join(", ")} · pull on ${PULL_PTS}pt move · ${SPREAD_BPS}bps spread · every ${intervalMs / 1000}s → logs/market-maker-*.jsonl`);
  await tick(fixtures, state);
  if (!once) setInterval(() => tick(fixtures, state), intervalMs);
}

// Only run when invoked directly, so the pure functions can be imported by the test suite side-effect-free.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
