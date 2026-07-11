#!/usr/bin/env node
/**
 * GAFFER settlement keeper — unattended.
 *
 * The product promises that the result itself releases the money. Something has to be awake for that to
 * be true. This is that something: a loop that asks the app to sweep every open pool and slip, on a tick
 * fast enough that a fan watching the goal go in sees the payout land before the replay finishes.
 *
 * It holds no keys and makes no decisions. It calls `/api/keeper`, which cranks `settle` — a CPI into
 * TxLINE's `validate_stat` that re-verifies the Merkle proof against anchored roots and returns a bool.
 * The keeper cannot make a market resolve the wrong way; the worst it can do is waste a transaction fee
 * asking a question the chain answers with "no".
 *
 * Every tick is appended to `logs/keeper-<date>.jsonl`, one JSON object per line, including the failures.
 * The log is the evidence: unattended operation is a claim, and claims need receipts.
 *
 *   BASE=https://gaffer-cyan.vercel.app GAFFER_ADMIN_KEY=… node agents/keeper-service.mjs
 *   node agents/keeper-service.mjs --once             # a single sweep, then exit (CI / smoke test)
 *   node agents/keeper-service.mjs --interval 15      # tick every 15s (default 20)
 *   node agents/keeper-service.mjs --fixture 18218149 # match day: watch one match, pay it in seconds
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ONCE = process.argv.includes("--once");
const INTERVAL_MS = Number(arg("interval", 20)) * 1000;
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3001")).replace(/\/$/, "");
/** Watch one match instead of the whole chain. On match day this is the difference between paying a
 *  goal out in seconds and sweeping every dead pool ever minted first. */
const FIXTURE = Number(arg("fixture", process.env.FIXTURE || 0)) || 0;
const ADMIN_KEY = process.env.GAFFER_ADMIN_KEY || "";
// The keeper route accepts either an operator key (x-gaffer-key) or the deployed agent host's own secret
// (x-ear-key === EAR_COMMIT_SECRET). On the droplet only the latter is provisioned (Vercel redacts the
// admin key on pull), so fall back to it — otherwise every sweep 401s and settlement silently dies.
const EAR_SECRET = process.env.EAR_COMMIT_SECRET || "";
const AUTH_HEADERS = ADMIN_KEY ? { "x-gaffer-key": ADMIN_KEY } : EAR_SECRET ? { "x-ear-key": EAR_SECRET } : {};

const logFile = () => {
  const day = new Date().toISOString().slice(0, 10);
  return resolve(ROOT, "logs", `keeper-${day}.jsonl`);
};
function record(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    mkdirSync(resolve(ROOT, "logs"), { recursive: true });
    appendFileSync(logFile(), line + "\n");
  } catch { /* a keeper that cannot write its log must still settle pools */ }
  return line;
}

/** The live slate worth settling on a fast tick — matches on now or about to be. A full-chain sweep walks
 * every pool ever minted (many dead, 403-ing on every tick) and can't finish inside the serverless budget,
 * so it 504s. We scope the fast keeper to the live fixtures and leave the whole-chain mop-up to the daily
 * cron. Discovered from the same schedule the app and the supervisor use. */
async function liveFixtures() {
  try {
    const { fixtures = [] } = await fetch(`${BASE}/api/fixtures`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
    return fixtures.filter((f) => f.state === "live" || f.state === "soon").map((f) => Number(f.fixtureId)).filter(Boolean);
  } catch { return []; }
}

/** Settle one fixture's open pools. Never throws — a keeper that dies on a network blip is not a keeper. */
async function sweepOne(fixture) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/keeper?fixture=${fixture}`, { method: "POST", headers: AUTH_HEADERS, signal: AbortSignal.timeout(55_000) });
    if (res.status === 401) {
      // Loud, not swallowed: a 401 means the settler is authenticated wrong and NO pool will ever pay —
      // exactly the silent failure that must never hide behind a heartbeat dot.
      console.error(record({ event: "settle_auth_fail", status: 401, fixture, note: "keeper unauthorized — set EAR_COMMIT_SECRET (or GAFFER_ADMIN_KEY) to the server's value" }));
      return { fatal: true };
    }
    const body = await res.json().catch(() => ({ error: "unparseable response" }));
    // Shout on real action or a real failure (body.errored = a pool that THREW), stay a quiet dot otherwise.
    const paid = (body.settled?.length || 0) + (body.voided?.length || 0) + (body.slips?.length || 0);
    if (paid > 0 || body.error || body.errored?.length) console.log(record({ event: "sweep", status: res.status, fixture, paid, ...body }));
    else { record({ event: "sweep", status: res.status, fixture, paid: 0, swept: body.swept, ms: body.ms }); process.stdout.write("."); }
    return { fatal: false };
  } catch (e) {
    console.log(record({ event: "error", fixture, ms: Date.now() - started, error: String(e?.message || e) }));
    return { fatal: false };
  }
}

/** One tick: settle an explicit fixture if given, else the whole live slate one match at a time (so each
 * call stays inside the serverless budget). Idle when nothing is on — the daily cron is the backstop. */
async function tick() {
  const fixtures = FIXTURE ? [FIXTURE] : await liveFixtures();
  if (!fixtures.length) { process.stdout.write("·"); return { fatal: false }; }
  let fatal = false;
  for (const f of fixtures) { if ((await sweepOne(f)).fatal) fatal = true; }
  return { fatal };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const authMode = ADMIN_KEY ? "admin key" : EAR_SECRET ? "agent secret" : "UNAUTHENTICATED — settles nothing";
console.log(`keeper → ${BASE}${FIXTURE ? ` · fixture ${FIXTURE}` : " · live slate"} every ${INTERVAL_MS / 1000}s  (auth: ${authMode})`);
console.log(`log    → ${logFile()}`);
record({ event: "start", base: BASE, fixture: FIXTURE || null, intervalMs: INTERVAL_MS, once: ONCE });

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; console.log(`\n${record({ event: "stop", signal: sig })}`); process.exit(0); });
}

do {
  const { fatal } = await tick();
  if (fatal) process.exit(1);
  if (ONCE || stopping) break;
  await sleep(INTERVAL_MS);
} while (!stopping);
