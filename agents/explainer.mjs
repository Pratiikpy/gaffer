#!/usr/bin/env node
/**
 * The Gaffer's Read — an autonomous AI analyst for Track 3 (Trading Tools & Agents).
 *
 * Watches the live de-margined line for a fixture and, the moment it moves sharply, asks the model to
 * explain what a swing that size signals — one plain sentence a fan or a trader can act on. This is the
 * "AI bot that explains odds changes" idea, wired to the real signed TxLINE market: the trigger is a
 * measured move in the implied %, and the explanation is grounded in that move.
 *
 * It is honest about its blind spot. The dev feed does not stream live score events, so the analyst reads
 * the MARKET (live and real) and never claims a goal or card it did not see — the /api/explain-move
 * prompt enforces that. What it produces is auditable: the move it fired on and the line it wrote, both
 * logged. Deterministic trigger (`detectMove`, shared shape with the detector), model-written prose.
 *
 *   node explainer.mjs --selftest
 *   GAFFER_API=https://gaffer-cyan.vercel.app node explainer.mjs <fixtureId…> [--interval 45] [--once]
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The same deterministic trigger the detector uses: the biggest side move ≥ threshold implied-% points,
 *  or null. Sharing the shape keeps "what counts as a move" consistent across the agents. */
export function detectMove(prev, next, threshold = 6) {
  if (!prev || !next) return null;
  let best = null;
  for (const k of ["home", "draw", "away"]) {
    const move = Math.abs((next[k] ?? 0) - (prev[k] ?? 0));
    if (move >= threshold && (!best || move > best.move)) best = { side: k, from: prev[k], to: next[k], move };
  }
  return best;
}

function selftest() {
  const a = detectMove({ home: 40, draw: 30, away: 30 }, { home: 52, draw: 24, away: 24 }); // home +12 → fire
  const b = detectMove({ home: 40, draw: 30, away: 30 }, { home: 43, draw: 29, away: 28 }); // <6 → null
  const c = detectMove(null, { home: 40, draw: 30, away: 30 });                             // cold start → null
  const ok = a && a.side === "home" && a.move === 12 && b === null && c === null;
  console.log("selftest:", ok ? "PASS" : "FAIL", JSON.stringify({ a, b, c }));
  process.exit(ok ? 0 : 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.GAFFER_API || process.env.BASE || arg("base", "http://127.0.0.1:3000")).replace(/\/$/, "");
const THRESHOLD = Number(process.env.MOVE_THRESHOLD || arg("threshold", 6));

function logLine(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { mkdirSync(resolve(ROOT, "logs"), { recursive: true }); appendFileSync(resolve(ROOT, "logs", `explainer-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n"); } catch { /* keep reading */ }
  return line;
}

/** Fixture names, so the read says "Spain", not a number. Cached; falls back to ids. */
const names = {};
async function nameFor(f) {
  if (names[f]) return names[f];
  try {
    const { fixtures = [] } = await fetch(`${BASE}/api/fixtures`).then((r) => r.json());
    for (const x of fixtures) names[x.fixtureId] = { home: x.homeTeam || x.home, away: x.awayTeam || x.away };
  } catch { /* ids are fine */ }
  return names[f] || { home: `home ${f}`, away: `away ${f}` };
}

async function tick(fixtures, state) {
  for (const f of fixtures) {
    try {
      const o = await fetch(`${BASE}/api/odds/${f}`).then((r) => r.json());
      if (!o?.hasOdds) continue;
      const now = { home: o.home, draw: o.draw, away: o.away };
      const move = detectMove(state[f], now, THRESHOLD);
      state[f] = now;
      if (!move) continue;
      const { home, away } = await nameFor(f);
      const read = await fetch(`${BASE}/api/explain-move`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ home, away, side: move.side, from: move.from, to: move.to }),
      }).then((r) => r.json()).catch(() => null);
      const line = read?.line || `The line moved ${move.move}pt on ${move.side}.`;
      logLine({ fixture: f, action: "read", move, source: read?.source || "none", line });
      console.log(`[READ] ${home} v ${away} · ${move.side} ${move.from}%→${move.to}% (${move.move}pt) · "${line}"`);
    } catch { /* transient feed/model error — skip this tick */ }
  }
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const fixtures = process.argv.slice(2).map(Number).filter(Boolean);
  if (!fixtures.length) { console.log("usage: node explainer.mjs <fixtureId…> [--interval 45] [--once] [--base URL]   |   --selftest"); process.exit(1); }
  const intervalMs = Number(arg("interval", 45)) * 1000;
  const once = process.argv.includes("--once");
  const state = {};
  console.log(`The Gaffer's Read · explaining live line moves on ${fixtures.join(", ")} · ≥${THRESHOLD}pt · every ${intervalMs / 1000}s → logs/explainer-*.jsonl`);
  await tick(fixtures, state);
  if (once) return;
  setInterval(() => tick(fixtures, state), intervalMs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
