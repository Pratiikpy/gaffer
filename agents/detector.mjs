#!/usr/bin/env node
/**
 * Sharp Movement Detector — Track 3 (Trading Tools & Agents).
 *
 * Autonomous tool: polls TxLINE's de-margined 1X2 implied % (via the GAFFER odds route, which proxies
 * the signed TxLINE feed) every 60s and flags significant line moves, logging each signal with a
 * timestamp. Deterministic detection logic (pure `detectMove`) so a professional desk can trust and
 * backtest it. Run `node detector.mjs --selftest` to verify the logic; `node detector.mjs <fixtureId…>`
 * to watch live.
 */
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.GAFFER_API || "http://127.0.0.1:3000";
const jfetch = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(12_000) }); // every feed call is bounded

const THRESHOLD = Number(process.env.MOVE_THRESHOLD || 5); // implied-% points to flag a "sharp move"

/** Pure, deterministic: given prev/next {home,draw,away} implied %, return the biggest qualifying move
 *  (or null). Same inputs → same output; this is what makes the signal auditable/backtestable. */
export function detectMove(prev, next, threshold = THRESHOLD) {
  if (!prev || !next) return null;
  let best = null;
  for (const k of ["home", "draw", "away"]) {
    const move = Math.abs((next[k] ?? 0) - (prev[k] ?? 0));
    if (move >= threshold && (!best || move > best.move)) best = { side: k, from: prev[k], to: next[k], move };
  }
  return best;
}

async function poll(fixtures, state, onSignal) {
  for (const f of fixtures) {
    try {
      const o = await jfetch(`${BASE}/api/odds/${f}`).then((r) => r.json());
      if (!o?.hasOdds) continue;
      const sig = detectMove(state[f], o);
      if (sig) onSignal({ ts: new Date().toISOString(), fixture: f, ...sig });
      state[f] = { home: o.home, draw: o.draw, away: o.away };
    } catch { /* transient feed error — skip this tick */ }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    const a = detectMove({ home: 27, draw: 32, away: 41 }, { home: 35, draw: 30, away: 35 }); // home +8 → flag
    const b = detectMove({ home: 27, draw: 32, away: 41 }, { home: 28, draw: 31, away: 41 }); // <5pt → null
    const c = detectMove(null, { home: 27, draw: 32, away: 41 }); // no prior → null (cold start)
    const ok = a && a.side === "home" && a.move === 8 && b === null && c === null;
    console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify({ a, b, c }));
    process.exit(ok ? 0 : 1);
  }

  const fixtures = args.filter((a, i) => !args.slice(0, i + 1).some((x) => x.startsWith("--"))).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node detector.mjs <fixtureId…>   |   node detector.mjs --selftest"); process.exit(1); }
  const state = {};
  console.log(`Sharp Movement Detector · watching ${fixtures.join(", ")} every 60s · threshold ${THRESHOLD}pt`);
  const tick = async () => poll(fixtures, state, (s) => {
    // Each signal is appended to a kept JSONL log, so the detector's decisions are auditable/backtestable
    // (matching every other agent) — not just interleaved in stdout.
    try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `detector-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ action: "sharp_move", ...s }) + "\n"); } catch { /* keep watching */ }
    console.log(`[SHARP MOVE] ${s.ts} · fixture ${s.fixture} · ${s.side} ${s.from}% → ${s.to}% (${s.move}pt swing)`);
  });
  await tick();
  setInterval(tick, 60_000);
}

// Only run when invoked directly (so this module can be imported by the test suite without side effects).
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
