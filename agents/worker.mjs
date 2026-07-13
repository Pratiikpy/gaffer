#!/usr/bin/env node
/**
 * Always-on agent supervisor — the deployable unit for Track 3 (Trading Tools & Agents).
 *
 * A single long-running process that keeps the four continuous agents pointed at whatever the tournament
 * is actually playing. It discovers fixtures itself from `/api/fixtures` (TxLINE's schedule, normalized
 * with a live/soon/finished state) so a deployed worker is never stuck on a stale hardcoded match — it
 * picks up the next kickoff on its own and drops matches once they finish.
 *
 * For each live-or-soon fixture it runs, as isolated child processes so one crash can't take the rest
 * down:
 *   detector      — flags sharp de-margined line moves
 *   market-maker  — quotes a two-sided book, pulls on a decisive move
 *   clv-tracker   — closing line value from entry to kickoff
 *   arena         — favorite vs underdog, settled by the real final score
 *
 * Everything each agent does is appended to logs/<agent>-<date>.jsonl; the supervisor's own decisions
 * (which fixtures it picked, restarts) go to logs/worker-<date>.jsonl. Deterministic agents, one env var
 * to point it at prod, no human in the loop.
 *
 *   GAFFER_API=https://www.mygaffer.xyz node agents/worker.mjs
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BASE = (process.env.GAFFER_API || process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const REFRESH_MS = Number(process.env.REFRESH_SECS || 300) * 1000;   // re-check the slate every 5 min
const AGENTS = ["detector", "market-maker", "clv-tracker", "arena", "explainer", "ear"];

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `worker-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n"); } catch { /* keep supervising */ }
  console.log(line);
}

/** The fixtures worth an agent's attention: live now, or kicking off soon. A `FIXTURES` env override
 *  (comma-separated ids) pins the watchlist — for a demo, or to force a specific match. */
async function watchlist() {
  if (process.env.FIXTURES) return process.env.FIXTURES.split(",").map(Number).filter(Boolean);
  const { fixtures = [] } = await fetch(`${BASE}/api/fixtures`).then((r) => r.json());
  return fixtures.filter((f) => f.state === "live" || f.state === "soon").map((f) => Number(f.fixtureId)).filter(Boolean);
}

/** ONE child per (agent, fixture), so each match's agent keeps its own state for its whole life. When the
 *  slate changes, only the affected matches start or stop — an unchanged match's agents are never killed,
 *  so a CLV entry or an Arena pick locked before kickoff survives another fixture entering the window.
 *  (The old design respawned every agent on any slate change, silently re-seeding those off the current,
 *  possibly mid-match line.) Keyed "agent\x00fixture" so an agent name with a hyphen never collides. */
const children = new Map();

function startOne(agent, fixture) {
  const key = `${agent}\x00${fixture}`;
  const args = [resolve(HERE, `${agent}.mjs`), String(fixture), "--interval", String(process.env.INTERVAL || 45)];
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, GAFFER_API: BASE }, stdio: ["ignore", "inherit", "inherit"] });
  const rec = { proc, stopped: false };
  proc.on("exit", (code) => {
    if (rec.stopped) return;                             // we killed it — match left the slate
    // A clean exit (code 0) is an agent that finished its own job, not a crash: clv-tracker and arena are
    // terminal — they lock their entry at kickoff / settle at full time, then exit 0. Respawning those would
    // (a) spin a pointless 10s restart loop for the rest of the match and (b) make clv re-seed its "entry"
    // at the current, post-kickoff line — silently corrupting the very closing-line-value it exists to
    // measure. Only restart on a real crash (non-zero exit).
    if (code === 0) { log({ event: "agent_done", agent, fixture, note: "clean exit — job finished, not restarting" }); children.delete(key); return; }
    log({ event: "agent_exit", agent, fixture, code, note: "crash — restarting in 10s" });
    setTimeout(() => { if (children.get(key) === rec) startOne(agent, fixture); }, 10_000);
  });
  children.set(key, rec);
}

function stopOne(key) {
  const rec = children.get(key);
  if (rec) { rec.stopped = true; try { rec.proc.kill(); } catch { /* already gone */ } children.delete(key); }
}

// Prompt settlement: the daily Vercel cron is only a backstop, so the moment a match leaves the live/soon
// window (it has finished), poke the keeper for that fixture — repeatedly over ~20 minutes, because the
// signed proof anchors a few minutes after full-time. Pools settle in minutes, not up to a day. The keeper
// re-verifies every proof on-chain, so this can only ASK it to settle, never misdirect a payout.
const settleQueue = new Map();   // fixtureId -> { left, total } — pokes remaining, and a lifetime cap
const SETTLE_TRIES = 8;          // 8 × 3min ≈ 24min: covers the usual few-minute post-full-time anchor
const SETTLE_MAX = 24;           // hard lifetime cap (~72min) if the proof is slow AND pools are still open
let watched = new Set();
async function settleTick() {
  const secret = process.env.EAR_COMMIT_SECRET;
  const hdr = secret ? { "x-ear-key": secret } : {};
  for (const [f, st] of [...settleQueue]) {
    let stillOpen = false;
    try {
      const r = await fetch(`${BASE}/api/keeper?fixture=${f}`, { headers: hdr, signal: AbortSignal.timeout(55_000) }).then((x) => x.json()).catch(() => null);
      // `paid` counts pools the keeper actually settled/voided/paid this poke; `errored` is a stuck payout
      // (a throw the keeper caught). Log either — the log is the Track-3 evidence, and a settle that keeps
      // failing must not vanish into a silent retry.
      const paid = (r?.settled?.length || 0) + (r?.voided?.length || 0) + (r?.slips?.length || 0);
      if (paid > 0) log({ event: "settled", fixture: f, paid, sigs: (r.settled || []).map((s) => s.sig).slice(0, 5) });
      if (r?.errored?.length) log({ event: "settle_stuck", fixture: f, errored: r.errored.slice(0, 5) });
      stillOpen = Number(r?.swept?.markets || 0) > 0;   // pools this fixture still hasn't settled
      // Grade the daily free call ("Goal before half-time?") off the same finished feed — idempotent, so a
      // repeat poke is harmless. Points only, never SOL; keyed to the fixture's single YES/NO truth.
      await fetch(`${BASE}/api/grade-picks?fixture=${f}`, { method: "POST", headers: hdr, signal: AbortSignal.timeout(55_000) })
        .then((x) => x.json()).then((g) => { if (g?.graded > 0) log({ event: "picks_graded", fixture: f, graded: g.graded, yesWon: g.yesWon }); })
        .catch(() => { /* the retry budget covers it */ });
    } catch { /* transient — the retry budget covers it */ }
    // Keep poking while pools remain open, up to the lifetime cap; otherwise let the budget run down. The
    // daily cron is still the final backstop for anything a slow proof outlasts even this.
    const left = st.left - 1, total = st.total + 1;
    if (left > 0) settleQueue.set(f, { left, total });
    else if (stillOpen && total < SETTLE_MAX) settleQueue.set(f, { left: 2, total });   // proof late, pools open → extend
    else settleQueue.delete(f);
  }
}

let booted = false;
async function reconcile() {
  let fixtures;
  try { fixtures = await watchlist(); }
  catch (e) { log({ event: "watchlist_error", error: String(e).slice(0, 120) }); return; }

  const want = new Set();
  for (const f of fixtures) for (const a of AGENTS) want.add(`${a}\x00${f}`);
  let changed = 0;
  for (const key of [...children.keys()]) if (!want.has(key)) { stopOne(key); changed++; }   // match finished / dropped
  for (const key of want) if (!children.has(key)) { const [a, f] = key.split("\x00"); startOne(a, Number(f)); changed++; }

  // A fixture that was live/soon and is now gone has finished — queue its pools for prompt settlement.
  const nowSet = new Set(fixtures);
  for (const f of watched) if (!nowSet.has(f) && !settleQueue.has(f)) { settleQueue.set(f, { left: SETTLE_TRIES, total: 0 }); log({ event: "settle_enqueue", fixture: f }); }
  watched = nowSet;

  const watching = [...nowSet];
  if (changed) log({ event: "slate", watching, agents: AGENTS });
  else if (!booted && !watching.length) log({ event: "idle", note: "no live or soon fixtures — agents parked until kickoff" });
  booted = true;
}

// Clean shutdown when run bare (systemd's KillMode handles the deployed case, but a Ctrl-C shouldn't orphan
// the whole fleet).
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const k of [...children.keys()]) stopOne(k); process.exit(0); });

log({ event: "boot", base: BASE, refreshSecs: REFRESH_MS / 1000, agents: AGENTS });
await reconcile();
setInterval(reconcile, REFRESH_MS);
setInterval(settleTick, 3 * 60_000);   // poke the keeper for just-finished matches every 3 minutes
