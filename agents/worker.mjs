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
 *   GAFFER_API=https://gaffer-cyan.vercel.app node agents/worker.mjs
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

/** One child per agent, watching the given fixtures. Auto-restarts on unexpected exit (unless we killed it
 *  to reload a new slate). */
const children = new Map();   // agent -> { proc, killedForReload }

function startAgent(agent, fixtures) {
  const args = [resolve(HERE, `${agent}.mjs`), ...fixtures.map(String), "--interval", String(process.env.INTERVAL || 45)];
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, GAFFER_API: BASE }, stdio: ["ignore", "inherit", "inherit"] });
  const rec = { proc, killedForReload: false };
  proc.on("exit", (code) => {
    if (rec.killedForReload) return;                     // expected — a reload is respawning it
    log({ event: "agent_exit", agent, code, note: "restarting in 10s" });
    setTimeout(() => { if (children.get(agent) === rec) startAgent(agent, fixtures); }, 10_000);
  });
  children.set(agent, rec);
}

function stopAll() {
  for (const rec of children.values()) { rec.killedForReload = true; try { rec.proc.kill(); } catch { /* already gone */ } }
  children.clear();
}

let current = "";
let booted = false;
async function reconcile() {
  let fixtures;
  try { fixtures = await watchlist(); }
  catch (e) { log({ event: "watchlist_error", error: String(e).slice(0, 120) }); return; }

  const key = fixtures.slice().sort((a, b) => a - b).join(",");
  if (key === current && booted) return;                 // slate unchanged — leave the agents running
  current = key;
  booted = true;

  stopAll();
  if (!fixtures.length) { log({ event: "idle", note: "no live or soon fixtures — agents parked until kickoff" }); return; }
  log({ event: "slate", fixtures, agents: AGENTS });
  for (const a of AGENTS) startAgent(a, fixtures);
}

log({ event: "boot", base: BASE, refreshSecs: REFRESH_MS / 1000, agents: AGENTS });
await reconcile();
setInterval(reconcile, REFRESH_MS);
