#!/usr/bin/env node
/**
 * CLV (Closing Line Value) Tracker — Track 3. The single metric professional bettors trust most: did
 * you get on a side BEFORE the market moved toward it? Positive CLV = a real edge, independent of any
 * single result. Pairs with the Sharp Movement Detector — feed it each signal's entry implied % and the
 * closing implied %, and it scores the edge. Deterministic core (`clv`/`summarize`), TxLINE-fed in prod
 * (entry from the signal, close from the last `/api/odds` before kickoff). `node clv-tracker.mjs --selftest`.
 */

/** Closing Line Value in implied-% points. You backed a side at `entryPct`; it closed at `closePct`.
 *  Positive = the market moved onto your pick after you were already there — the sharpest edge proxy. */
export function clv(entryPct, closePct) {
  return Number(((closePct ?? 0) - (entryPct ?? 0)).toFixed(2));
}

/** Aggregate a list of {entryPct, closePct} signals into avg CLV + beat-the-close rate. */
export function summarize(signals) {
  const clvs = signals.map((s) => clv(s.entryPct, s.closePct));
  const n = signals.length || 1;
  const avg = clvs.reduce((a, b) => a + b, 0) / n;
  const beat = clvs.filter((c) => c > 0).length;
  return { count: signals.length, avgClv: Number(avg.toFixed(2)), beatRate: Number((beat / n).toFixed(2)) };
}

function selftest() {
  // Entry ahead of close on 3 of 4 → positive avg CLV, beat rate 0.75.
  const signals = [
    { entryPct: 27, closePct: 33 }, // +6 (got on before the move)
    { entryPct: 40, closePct: 45 }, // +5
    { entryPct: 50, closePct: 44 }, // −6 (market moved away)
    { entryPct: 30, closePct: 34 }, // +4
  ];
  const r = summarize(signals);
  const ok = clv(27, 33) === 6 && r.avgClv === 2.25 && r.beatRate === 0.75 && r.count === 4;
  console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify(r));
  process.exit(ok ? 0 : 1);
}

// ── live loop ────────────────────────────────────────────────────────────────────────────────────────
// Entry = the line when tracking begins (or --entry, seeded from a detector signal). Close = the last
// line before the match goes in-running, which /api/live reports (running flips true at kickoff). CLV is
// then close − entry for the chosen side: did the market move onto the pick before the whistle?
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3000")).replace(/\/$/, "");
const SIDE = ["home", "draw", "away"].includes(arg("side", "home")) ? arg("side", "home") : "home";
const SEED_ENTRY = process.argv.includes("--entry") ? Number(arg("entry", "")) : null;

function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `clv-tracker-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n"); } catch { /* keep tracking */ }
  return line;
}

async function tick(fixtures, state) {
  for (const f of fixtures) {
    const st = state[f];
    if (st.closed) continue;
    try {
      const [o, live] = await Promise.all([
        fetch(`${BASE}/api/odds/${f}`).then((r) => r.json()),
        fetch(`${BASE}/api/live?fixture=${f}`).then((r) => r.json()).catch(() => ({})),
      ]);
      if (!o?.hasOdds) continue;
      const line = o[SIDE];
      if (st.entry == null) { st.entry = SEED_ENTRY ?? line; logLine({ fixture: f, action: "entry", side: SIDE, entry: st.entry }); }

      if (live?.running) {
        // Kickoff — the close is the last line we saw before the whistle. Finalize CLV.
        const close = st.lastLine ?? line;
        const value = clv(st.entry, close);
        logLine({ fixture: f, action: "close", side: SIDE, entry: st.entry, close, clv: value });
        console.log(`[CLOSE] fixture ${f} · ${SIDE} entry ${st.entry}% → close ${close}% · CLV ${value >= 0 ? "+" : ""}${value}pt`);
        st.closed = true;
      } else {
        st.lastLine = line;
        const running = clv(st.entry, line);
        logLine({ fixture: f, action: "track", side: SIDE, entry: st.entry, line, clv: running });
        console.log(`[TRACK] fixture ${f} · ${SIDE} ${st.entry}% → ${line}% · running CLV ${running >= 0 ? "+" : ""}${running}pt`);
      }
    } catch { /* transient feed error — skip this tick */ }
  }
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const fixtures = process.argv.slice(2).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node clv-tracker.mjs <fixtureId…> [--side home|draw|away] [--entry PCT] [--interval 60] [--base URL]   |   --selftest"); process.exit(1); }
  const intervalMs = Number(arg("interval", 60)) * 1000;
  const once = process.argv.includes("--once");
  const state = Object.fromEntries(fixtures.map((f) => [f, { entry: null, lastLine: null, closed: false }]));
  console.log(`CLV Tracker · ${SIDE} side · watching ${fixtures.join(", ")} to close · every ${intervalMs / 1000}s → logs/clv-tracker-*.jsonl`);
  await tick(fixtures, state);
  if (once) return;
  const timer = setInterval(async () => {
    await tick(fixtures, state);
    if (Object.values(state).every((s) => s.closed)) { clearInterval(timer); console.log("all fixtures closed — CLV finalized."); }
  }, intervalMs);
}

// Only run when invoked directly, so the pure functions import side-effect-free into the test suite.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
