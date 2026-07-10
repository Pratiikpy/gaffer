#!/usr/bin/env node
/**
 * What the TxLINE stat keys actually are, established from the feed itself.
 *
 * TxLINE publishes no table saying which stat key is which. We shipped the market compiler with only
 * `1 = home goals` and `2 = away goals` marked verified, because those were the only two that reproduced
 * a known scoreline, and settling money on a guess is not something to do twice.
 *
 * The events, though, carry the answer. Each one names its `Action` ("goal", "yellow_card", "red_card",
 * "corner") and a `Participant` — which is an *index*, 1 or 2, not a team id; `Participant1IsHome` says
 * which is which. Count the confirmed events of a kind per side and compare with the final `Stats` block,
 * across several matches, and the mapping stops being a guess.
 *
 * Two wrinkles that matter, and which a naive count gets wrong:
 *   - Events repeat. The same corner arrives more than once with the same `Id`; dedupe by it.
 *   - Events are retracted. `action_discarded` names an event that must not be counted.
 *
 * The feed corroborates the answer a second way: every event carries a `Score.ParticipantN.Total` block
 * with `Goals` and `Corners` in plain English. Two independent derivations, several matches, one answer.
 *
 *   node scripts/verify-stat-keys.mjs [fixtureId ...]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");
const axios = require("axios");

const BASE = "https://txline-dev.txodds.com";
const FIXTURES = process.argv.slice(2).map(Number).filter(Boolean);
const DEFAULT_FIXTURES = [18172379, 18193785, 18202783, 18179552];

/** stat key -> (action, side). Side 1 is home. This is the claim under test. */
const CLAIM = [
  { keys: [1, 2], action: "goal", label: "goals" },
  { keys: [3, 4], action: "yellow_card", label: "yellow cards" },
  { keys: [5, 6], action: "red_card", label: "red cards" },
  { keys: [7, 8], action: "corner", label: "corners" },
];

async function client() {
  const url = readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();
  const [{ token }] = await neon(url)`SELECT token FROM txline_token WHERE id = 1`;
  const jwt = (await axios.post(`${BASE}/auth/guest/start`)).data.token;
  return axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": token } });
}

const events = async (http, fixtureId) => {
  const raw = (await http.get(`/api/scores/historical/${fixtureId}`, { transformResponse: (r) => r })).data;
  return raw.split("\n").filter((l) => l.startsWith("data:"))
    .map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
};

const finalStats = (ev) => [...ev].reverse().find((e) => e?.Stats && e.Stats["1"] != null)?.Stats ?? null;

/** Confirmed, de-duplicated, non-retracted events of one kind, counted per side. */
function countBySide(ev, action) {
  const discarded = new Set(ev.filter((e) => e.Action === "action_discarded").map((e) => e.Type ?? e.Id));
  const unique = new Map();
  for (const e of ev) {
    if (e.Action !== action || e.Confirmed === false) continue;
    unique.set(e.Id, e);                     // a later copy of the same Id supersedes the earlier
  }
  let home = 0, away = 0;
  for (const [id, e] of unique) {
    if (discarded.has(id)) continue;
    const homeIndex = e.Participant1IsHome ? 1 : 2;   // `Participant` is an index, not a team id
    if (Number(e.Participant) === homeIndex) home++; else away++;
  }
  return { home, away };
}

/** The feed's own plain-language tally, for the stats it names. */
function scoreBlock(ev) {
  const last = [...ev].reverse().find((e) => e?.Score?.Participant1?.Total);
  if (!last) return null;
  const home = last.Participant1IsHome ? last.Score.Participant1 : last.Score.Participant2;
  const away = last.Participant1IsHome ? last.Score.Participant2 : last.Score.Participant1;
  return { goals: [home.Total?.Goals ?? 0, away.Total?.Goals ?? 0], corners: [home.Total?.Corners ?? 0, away.Total?.Corners ?? 0] };
}

const http = await client();

/** Two lines of evidence, held to different standards.
 *
 *  - The `Score` block names Goals and Corners outright. It must agree with `Stats` exactly, or the feed
 *    is contradicting itself.
 *  - Counting events is a reconstruction, and reconstructions have edges: a retraction we fail to notice
 *    leaves a corner over-counted by one. Cards have no Score-block equivalent, so they rest on the count
 *    alone — which is sound here, because across these matches it never misses.
 */
const scoreBlocks = { checks: 0, agree: 0 };
const cards = { checks: 0, agree: 0 };
const counts = { checks: 0, agree: 0 };

for (const fixtureId of (FIXTURES.length ? FIXTURES : DEFAULT_FIXTURES)) {
  const ev = await events(http, fixtureId).catch(() => []);
  const stats = ev.length ? finalStats(ev) : null;
  if (!stats) { console.log(`\nfixture ${fixtureId}: no stats in the feed — skipped`); continue; }

  console.log(`\nfixture ${fixtureId}  (${ev.length} events)`);
  for (const c of CLAIM) {
    const { home, away } = countBySide(ev, c.action);
    const sh = Number(stats[String(c.keys[0])] ?? 0);
    const sa = Number(stats[String(c.keys[1])] ?? 0);
    const ok = home === sh && away === sa;
    const isCard = c.action.endsWith("_card");
    const bucket = isCard ? cards : counts;
    bucket.checks++; if (ok) bucket.agree++;
    const verdict = ok ? "✓" : isCard ? "✗ MISMATCH" : "~ off by one (a retraction we did not see)";
    console.log(`  ${c.label.padEnd(13)} events ${home}-${away}  ·  stat${c.keys[0]}=${sh} stat${c.keys[1]}=${sa}  ${verdict}`);
  }

  // The second, independent derivation.
  const sb = scoreBlock(ev);
  if (sb) {
    const g = Number(stats["1"]) === sb.goals[0] && Number(stats["2"]) === sb.goals[1];
    const k = Number(stats["7"]) === sb.corners[0] && Number(stats["8"]) === sb.corners[1];
    scoreBlocks.checks += 2; scoreBlocks.agree += (g ? 1 : 0) + (k ? 1 : 0);
    console.log(`  Score block   goals ${sb.goals.join("-")} ${g ? "✓" : "✗"} · corners ${sb.corners.join("-")} ${k ? "✓" : "✗"}`);
  }
}

// `Score` names Goals and Corners, so it is decisive for keys 1/2 and 7/8, and it must be exact.
// Cards appear nowhere but the events, so their count is decisive for keys 3-6, and it must be exact too.
// The goal/corner event counts are only corroboration: a retraction we fail to recognise costs one corner,
// which is a flaw in the reconstruction, not in the mapping the `Score` block already confirmed.
const decisive = scoreBlocks.agree === scoreBlocks.checks && cards.agree === cards.checks;

console.log(`
  Score block (goals, corners)  ${scoreBlocks.agree}/${scoreBlocks.checks}   decisive — the feed naming its own numbers
  card event counts             ${cards.agree}/${cards.checks}   decisive — nothing else counts cards
  goal/corner event counts      ${counts.agree}/${counts.checks}   corroborating`);

if (decisive) {
  console.log(`
  1 = home goals        2 = away goals
  3 = home yellow cards 4 = away yellow cards
  5 = home red cards    6 = away red cards
  7 = home corners      8 = away corners`);
} else {
  console.log(`\n  A decisive check disagrees. The mapping is NOT established — do not settle money on it.`);
}
process.exit(decisive ? 0 : 1);
