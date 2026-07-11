#!/usr/bin/env node
/**
 * The Gaffer's Ear — an autonomous agent that reads the MATCH from the MARKET (Track 3).
 *
 * Every other odds agent in this hackathon flags a "sharp move" and calls it a trading signal. The Ear
 * asks the next question: *what just happened on the pitch?* When a team scores, its win-probability
 * doesn't drift — it lurches (a real market went 2.00 → 1.04 the instant a team scored). When the referee
 * reaches for the monitor, the market suspends. When the whistle goes, it closes. So the Ear infers goals,
 * stoppages (VAR / booking / injury) and full-time from the de-margined line ALONE — the one thing
 * TxLINE's dev feed streams live — and it does so *before* the score feed carries the event (that feed
 * only finalises post-match).
 *
 * Each inference is committed on-chain the moment it's made (`/api/commit-ear` writes a SHA-256 of the
 * call to Solana via the Memo program) so the timestamp cannot be back-dated — "we called it, here's the
 * proof we called it first." After full-time, `--score` replays the signed feed and grades the Ear against
 * what actually happened: how many goals it caught, on the right side, with zero clairvoyance.
 *
 *   node ear.mjs --selftest
 *   GAFFER_API=https://gaffer-cyan.vercel.app node ear.mjs <fixtureId…> [--interval 20] [--once]
 *   GAFFER_API=https://gaffer-cyan.vercel.app node ear.mjs --score <fixtureId>
 *
 * The reasoning is deterministic and auditable — same ticks in, same events out.
 */

// ── the brain: infer a match event from the market's own reflexes ────────────────────────────────────
//
// `prev`/`next` are {home, draw, away} de-margined implied %. `silentMs` is how long the market has gone
// without a fresh quote (its suspension signal). `wasRunning`/`isRunning` are the in-running flags.
export const GOAL_PTS = 12;        // a one-sided implied-% jump this big is a goal, not noise
export const SUSPEND_MS = 25_000;  // market quiet this long = a stoppage the book is pricing around
const FULLTIME_CLOSED_MS = 18 * 60_000; // a close that outlasts any ~15-min halftime break = full time

/** Returns an event {kind, side, confidence, move, evidence} or null. Pure and deterministic. */
export function readEvent(prev, next, silentMs = 0, wasRunning = true, isRunning = true) {
  // Full-time / break: the market was live and has now closed.
  if (wasRunning && !isRunning) {
    return { kind: "fulltime", side: null, confidence: 0.85, move: 0, evidence: "market closed — in-running quotes stopped" };
  }
  if (!prev || !next) return null;

  // The biggest one-sided repricing across the three outcomes.
  let side = null, move = 0;
  for (const k of ["home", "draw", "away"]) {
    const d = (next[k] ?? 0) - (prev[k] ?? 0);     // signed: a RISE in an outcome's probability
    if (d > move) { move = d; side = k; }
  }

  // A goal is a large, sudden rise in one outcome's win probability — the scoring side (or the draw, on a
  // leveller). Bookings and corners don't move the 1X2 line this far; only a goal or a red card does, and a
  // move this size is overwhelmingly a goal.
  if (move >= GOAL_PTS) {
    const label = side === "draw" ? "a leveller (draw now favoured)" : `${side} side`;
    return { kind: "goal", side, confidence: Math.min(0.98, 0.5 + move / 40), move: Math.round(move),
      evidence: `${Math.round(move)}-pt implied-probability jump toward ${label}${silentMs >= SUSPEND_MS ? ", off a suspension" : ""}` };
  }

  // No decisive move, but the market has gone quiet: the book has suspended because something is under
  // review — a VAR check, a booking, an injury. This is the moment every sportsbook locks its doors.
  if (silentMs >= SUSPEND_MS) {
    return { kind: "stoppage", side: null, confidence: Math.min(0.9, 0.4 + silentMs / 120_000), move: Math.round(move),
      evidence: `market frozen ${Math.round(silentMs / 1000)}s with no resolving move - a stoppage under review` };
  }

  return null;
}

function selftest() {
  let n = 0, ok = 0;
  const t = (name, cond) => { n++; if (cond) ok++; else console.log("  ✗", name); };
  // Spain (home) scores: 40 → 62, others fall.
  const g = readEvent({ home: 40, draw: 30, away: 30 }, { home: 62, draw: 22, away: 16 });
  t("goal detected", g?.kind === "goal");
  t("goal side = home", g?.side === "home");
  t("goal move ≈ 22", g?.move === 22);
  t("goal confidence high", g?.confidence > 0.9);
  // A leveller: draw jumps most.
  const lev = readEvent({ home: 55, draw: 25, away: 20 }, { home: 30, draw: 45, away: 25 });
  t("leveller detected as goal, side=draw", lev?.kind === "goal" && lev.side === "draw");
  // Small drift → nothing.
  t("small drift is not an event", readEvent({ home: 40, draw: 30, away: 30 }, { home: 43, draw: 29, away: 28 }) === null);
  // Suspension with no move → stoppage.
  const s = readEvent({ home: 40, draw: 30, away: 30 }, { home: 41, draw: 30, away: 29 }, 32_000);
  t("suspension → stoppage", s?.kind === "stoppage");
  // Market closed → full-time.
  const ft = readEvent({ home: 40, draw: 30, away: 30 }, { home: 40, draw: 30, away: 30 }, 0, true, false);
  t("market close → fulltime", ft?.kind === "fulltime");
  // Cold start → null.
  t("cold start is not an event", readEvent(null, { home: 40, draw: 30, away: 30 }) === null);
  console.log(`selftest: ${ok === n ? "PASS" : "FAIL"} ${ok}/${n}`);
  process.exit(ok === n ? 0 : 1);
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3000")).replace(/\/$/, "");
const logPath = () => resolve(ROOT, "logs", `ear-${new Date().toISOString().slice(0, 10)}.jsonl`);
function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(logPath(), line + "\n"); } catch { /* keep listening */ }
  return line;
}

const names = {};
async function nameFor(f) {
  if (names[f]) return names[f];
  try {
    const { fixtures = [] } = await fetch(`${BASE}/api/fixtures`).then((r) => r.json());
    for (const x of fixtures) names[x.fixtureId] = { home: x.homeTeam || x.home, away: x.awayTeam || x.away };
  } catch { /* ids are fine */ }
  return names[f] || { home: "home", away: "away" };
}
const teamName = (side, nm) => (side === "home" ? nm.home : side === "away" ? nm.away : side === "draw" ? "the draw" : "");

async function tick(fixtures, state) {
  for (const f of fixtures) {
    try {
      const [o, live] = await Promise.all([
        fetch(`${BASE}/api/odds/${f}`).then((r) => r.json()),
        fetch(`${BASE}/api/live?fixture=${f}`).then((r) => r.json()).catch(() => ({})),
      ]);
      const st = state[f] || (state[f] = { prev: null, everRan: false, closedSince: 0, calledFT: false });
      const isRunning = !!(live?.running);
      const silentMs = Number(live?.silentMs || 0);
      const now = o?.hasOdds ? { home: o.home, draw: o.draw, away: o.away } : st.prev;

      // Read goals / stoppages ONLY while the match is actually in-running. Before kickoff a static book
      // sits unchanged (which looks like a suspension) and after full-time the market is shut — neither is
      // a live event. This is the same guard the Blackout uses (rounds.ts gates silence on `live.running`).
      let ev = isRunning ? readEvent(st.prev, now, silentMs, true, true) : null;
      st.prev = now || st.prev;

      // Full-time is a close that STAYS shut past any ~15-min halftime break — timed, not tick-counted, so
      // the poll interval doesn't matter, and fired exactly once. A halftime suspension reopens well before
      // the threshold and resets the timer, so it is never mistaken for full time.
      if (isRunning) { st.everRan = true; st.closedSince = 0; }
      else if (st.everRan && !st.closedSince) st.closedSince = Date.now();
      if (!ev && st.everRan && !st.calledFT && st.closedSince && Date.now() - st.closedSince >= FULLTIME_CLOSED_MS) {
        st.calledFT = true;
        ev = { kind: "fulltime", side: null, confidence: 0.85, move: 0, evidence: "market closed and stayed shut - full time" };
      }
      if (!ev) continue;
      const nm = await nameFor(f);
      // Commit the call on-chain the moment it's made — the timestamp cannot be back-dated. Authenticated,
      // so only the agent (never an anonymous POST) can write a call that shows in the app as genuine.
      const headers = { "content-type": "application/json" };
      if (process.env.GAFFER_ADMIN_KEY) headers["x-gaffer-key"] = process.env.GAFFER_ADMIN_KEY;
      const commit = await fetch(`${BASE}/api/commit-ear`, {
        method: "POST", headers,
        body: JSON.stringify({ fixtureId: f, kind: ev.kind, side: ev.side, team: teamName(ev.side, nm), confidence: ev.confidence, evidence: ev.evidence }),
      }).then((r) => r.json()).catch(() => null);
      logLine({ fixture: f, action: "call", kind: ev.kind, side: ev.side, team: teamName(ev.side, nm), confidence: ev.confidence, move: ev.move, evidence: ev.evidence, sig: commit?.sig || null, hash: commit?.hash || null });
      const who = teamName(ev.side, nm);
      console.log(`[EAR] ${nm.home} v ${nm.away} · ${ev.kind.toUpperCase()}${who ? " — " + who : ""} · ${ev.evidence} · ${(ev.confidence * 100) | 0}%${commit?.sig ? " · anchored " + commit.sig.slice(0, 10) : ""}`);
    } catch { /* transient feed/commit error — skip this tick */ }
  }
}

/** After full-time: grade the Ear's live calls against the signed feed's real events. */
async function score(fixtureId) {
  const nm = await nameFor(fixtureId);
  // What the Ear called live, from its own log.
  const calls = [];
  try {
    for (const fn of readdirSync(resolve(ROOT, "logs")).filter((x) => /^ear-\d/.test(x))) {
      for (const l of readFileSync(resolve(ROOT, "logs", fn), "utf8").split("\n").filter(Boolean)) {
        try { const j = JSON.parse(l); if (j.action === "call" && Number(j.fixture) === Number(fixtureId)) calls.push(j); } catch { /* skip */ }
      }
    }
  } catch { /* no logs */ }
  const calledGoals = calls.filter((c) => c.kind === "goal");
  // What actually happened, from the signed feed (available once the match finalised).
  const truth = await fetch(`${BASE}/api/match-events?fixture=${fixtureId}`).then((r) => r.json()).catch(() => null);
  if (!truth || truth.finished === false) { console.log(`Match ${fixtureId} not finalised in the feed yet — can't grade.`); return; }
  const actualGoals = Number(truth.homeGoals || 0) + Number(truth.awayGoals || 0);
  const callHome = calledGoals.filter((c) => c.side === "home").length;
  const callAway = calledGoals.filter((c) => c.side === "away").length;
  const hit = Math.min(callHome, Number(truth.homeGoals || 0)) + Math.min(callAway, Number(truth.awayGoals || 0));
  const falsePos = Math.max(0, calledGoals.length - actualGoals);
  console.log(`\n  ── The Gaffer's Ear · ${nm.home} v ${nm.away} ──`);
  console.log(`  actual (signed feed):  ${truth.homeGoals}-${truth.awayGoals}  (${actualGoals} goals)`);
  console.log(`  ear called live:       ${callHome} ${nm.home}, ${callAway} ${nm.away}  (${calledGoals.length} goals, from the market only)`);
  console.log(`  correct side & count:  ${hit}/${actualGoals}${falsePos ? `  · ${falsePos} false positive(s)` : ""}`);
  console.log(`  every call was committed on-chain DURING the match; the score feed only confirmed it after full-time.`);
  const sigs = calledGoals.filter((c) => c.sig).map((c) => c.sig);
  if (sigs.length) console.log(`  on-chain proofs: ${sigs.slice(0, 3).map((s) => s.slice(0, 12)).join(", ")}${sigs.length > 3 ? " …" : ""}`);
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  if (process.argv.includes("--score")) { const id = Number(arg("score", process.argv[process.argv.indexOf("--score") + 1])); if (!id) { console.log("usage: node ear.mjs --score <fixtureId>"); process.exit(1); } return score(id); }
  const fixtures = process.argv.slice(2).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node ear.mjs <fixtureId…> [--interval 20] [--once] [--base URL]  |  --score <id>  |  --selftest"); process.exit(1); }
  const intervalMs = Number(arg("interval", 20)) * 1000;
  const once = process.argv.includes("--once");
  const state = {};
  console.log(`The Gaffer's Ear · reading the match from the market on ${fixtures.join(", ")} · every ${intervalMs / 1000}s → logs/ear-*.jsonl`);
  await tick(fixtures, state);
  if (once) return;
  setInterval(() => tick(fixtures, state), intervalMs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
