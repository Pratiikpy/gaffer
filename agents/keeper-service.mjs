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
 *   node agents/keeper-service.mjs --once          # a single sweep, then exit (CI / smoke test)
 *   node agents/keeper-service.mjs --interval 15   # tick every 15s (default 20)
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
const BASE = (process.env.BASE || arg("base", "http://127.0.0.1:3001")).replace(/\/$/, "");
const ADMIN_KEY = process.env.GAFFER_ADMIN_KEY || "";

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

/** One sweep. Never throws — a keeper that dies on a network blip is not a keeper. */
async function tick() {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/keeper`, {
      method: "POST",
      headers: ADMIN_KEY ? { "x-gaffer-key": ADMIN_KEY } : {},
      signal: AbortSignal.timeout(55_000),
    });
    if (res.status === 401) {
      console.error("keeper: unauthorized — set GAFFER_ADMIN_KEY to the value configured on the server");
      return { fatal: true };
    }
    const body = await res.json().catch(() => ({ error: "unparseable response" }));

    // Only shout when something actually happened. A quiet keeper on a quiet night is correct.
    const paid = (body.settled?.length || 0) + (body.voided?.length || 0) + (body.slips?.length || 0);
    if (paid > 0 || body.error) {
      console.log(record({ event: "sweep", status: res.status, paid, ...body }));
    } else {
      record({ event: "sweep", status: res.status, paid: 0, swept: body.swept, ms: body.ms });
      process.stdout.write(".");
    }
    return { fatal: false };
  } catch (e) {
    console.log(record({ event: "error", ms: Date.now() - started, error: String(e?.message || e) }));
    return { fatal: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`keeper → ${BASE} every ${INTERVAL_MS / 1000}s${ADMIN_KEY ? "" : "  (no admin key: dev-open servers only)"}`);
console.log(`log    → ${logFile()}`);
record({ event: "start", base: BASE, intervalMs: INTERVAL_MS, once: ONCE });

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
