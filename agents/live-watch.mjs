#!/usr/bin/env node
/**
 * Live-match watcher — the paths that have never run against a moving clock.
 *
 * Everything in this app was built and tested against finished replay fixtures. A replay has a stopped
 * clock, a final score and no odds stream, so five things have never once executed for real: the clock
 * running, halftime detection, the Blackout arming off a genuine gap in the odds, the Frozen Window
 * opening mid-match, and the keeper settling a goal as it goes in.
 *
 * This watches one fixture and writes down the moment each of them happens, once. It asserts nothing it
 * cannot see and invents nothing it did not: a transition is only recorded when the feed actually shows
 * it. The interesting number it produces is `paidAfterMs` — the gap between a goal appearing in the feed
 * and the pool on it settling on-chain. That is the product's whole claim, measured rather than asserted.
 *
 *   BASE=https://gaffer-cyan.vercel.app node agents/live-watch.mjs --fixture 18218149
 *   node agents/live-watch.mjs --fixture 18172379 --once   # sanity check against a finished match
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ONCE = process.argv.includes("--once");
const BASE = (process.env.BASE || arg("base", "http://127.0.0.1:3001")).replace(/\/$/, "");
const FIXTURE = Number(arg("fixture", process.env.FIXTURE || 0));
const INTERVAL_MS = Number(arg("interval", 15)) * 1000;

if (!FIXTURE) { console.error("live-watch: --fixture <id> is required"); process.exit(1); }

const logFile = () => resolve(ROOT, "logs", `live-${FIXTURE}-${new Date().toISOString().slice(0, 10)}.jsonl`);
function record(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(logFile(), line + "\n"); } catch { /* keep watching */ }
  return line;
}

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

/** Fire a named milestone exactly once, the first time its condition holds. */
const seen = new Set();
function milestone(name, cond, detail) {
  if (seen.has(name) || !cond) return false;
  seen.add(name);
  console.log("\n" + record({ event: "milestone", milestone: name, ...detail }));
  return true;
}

/** Goals we have observed in the feed, and when. Used to measure how long the payout took. */
const goalsAt = new Map();      // "home"|"away" -> { count, firstSeenMs }
let lastPools = new Map();      // pubkey -> status

async function tick() {
  const [pulse, markets, rounds] = await Promise.all([
    get(`/api/live?fixture=${FIXTURE}`),
    get(`/api/markets`).then((d) => d.markets.filter((m) => Number(m.fixtureId) === FIXTURE)),
    get(`/api/rounds?fixture=${FIXTURE}`).catch(() => ({ active: null, settled: null })),
  ]);

  // The Frozen Window: the minute every book locks its doors, our round opens. It has only ever been
  // triggered by hand or by a replay's odds gap — this is the first time it can fire off a real one.
  milestone("frozen_window_opened", !!rounds.active, { round: rounds.active?.id ?? null, reason: rounds.active?.reason ?? null });
  milestone("frozen_window_settled", !!rounds.settled, { round: rounds.settled?.id ?? null });

  const { running, clockSeconds, atHalftime, secondHalf, finished, homeGoals, awayGoals, marketQuiet, silentMs } = pulse;

  milestone("feed_alive", clockSeconds !== null || homeGoals !== null, { clockSeconds, homeGoals, awayGoals });
  milestone("clock_running", running === true, { clockSeconds });
  milestone("halftime", atHalftime === true, { clockSeconds });
  milestone("second_half", secondHalf === true && running === true, { clockSeconds });
  milestone("blackout_armed", marketQuiet === true && running === true, { silentMs, clockSeconds });
  milestone("full_time", finished === true, { homeGoals, awayGoals });

  // A goal is a rise in the scoreline. Note the instant we first saw it; the keeper's settle closes the loop.
  for (const [side, goals] of [["home", homeGoals], ["away", awayGoals]]) {
    if (typeof goals !== "number") continue;
    const prev = goalsAt.get(side)?.count ?? 0;
    if (goals > prev) {
      goalsAt.set(side, { count: goals, firstSeenMs: Date.now() });
      console.log("\n" + record({ event: "goal", side, goals, clockSeconds }));
    }
  }

  // A pool leaving "open" is the payout. status 1 = paid (YES), 2 = refunded (void).
  for (const m of markets) {
    const was = lastPools.get(m.pubkey);
    if (was === 0 && m.status !== 0) {
      const side = m.statKey === 1 ? "home" : m.statKey === 2 ? "away" : null;
      const goal = side ? goalsAt.get(side) : null;
      console.log("\n" + record({
        event: "settled",
        market: m.pubkey, statKey: m.statKey, status: m.status,
        outcome: m.status === 1 ? "PAID (yes)" : m.status === 2 ? "REFUNDED (void)" : String(m.status),
        pot: (Number(m.yesTotal) + Number(m.noTotal)) / 1e9,
        // The number the whole product is about: goal seen in the feed → money released on-chain.
        paidAfterMs: goal ? Date.now() - goal.firstSeenMs : null,
      }));
    }
    lastPools.set(m.pubkey, m.status);
  }

  if (!seen.has("_primed")) {
    seen.add("_primed");
    record({ event: "start", base: BASE, fixture: FIXTURE, pools: markets.map((m) => m.pubkey) });
  }
  process.stdout.write(finished ? "F" : running ? "." : atHalftime ? "H" : "_");
  return finished === true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`live-watch → ${BASE} · fixture ${FIXTURE} every ${INTERVAL_MS / 1000}s`);
console.log(`log        → ${logFile()}`);
console.log(`legend: _ waiting  . clock running  H halftime  F full time\n`);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log("\n" + record({ event: "stop", signal: sig })); process.exit(0); });

let done = false;
do {
  try { done = await tick(); }
  catch (e) { console.log("\n" + record({ event: "error", error: String(e?.message || e) })); }
  if (ONCE) break;
  if (done) { record({ event: "finished", milestones: [...seen].filter((s) => !s.startsWith("_")) }); break; }
  await sleep(INTERVAL_MS);
} while (true);
