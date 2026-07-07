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

if (process.argv.includes("--selftest")) selftest();
else console.log("CLV Tracker · import { clv, summarize } or run with --selftest. Live: entry from a detector signal, close from the last /api/odds before kickoff.");
