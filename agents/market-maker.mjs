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

function selftest() {
  const q = quote(40, { spreadBps: 400 });
  const spreadOk = q.bid < q.fair && q.fair < q.ask && Math.round((q.ask - q.bid) * 10000) === 400;
  const clampOk = quote(1).bid >= 0.01 && quote(99).ask <= 0.99;
  const pullOnGoal = onEvent("goal") === null;
  const holdOnThrowIn = onEvent("throw_in") === "hold";
  const ok = spreadOk && clampOk && pullOnGoal && holdOnThrowIn;
  console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify({ q, pullOnGoal, holdOnThrowIn }));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else console.log("In-Play Market Maker · import { quote, onEvent } or run with --selftest. Live: quote off /api/odds, pull on the TxLINE event stream.");
