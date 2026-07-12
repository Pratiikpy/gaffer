import "server-only";
import { db } from "./db";
import { matchResult, type MatchResult } from "./matchResult";
import { cached } from "./cache";
import { fixtureNames } from "./fixtureNames";

/** The Gaffer's Ear's track record — does its market-read actually predict the pitch?
 *
 * The Ear infers goals / stoppages / full-time from the live de-margined line and stamps each call on-chain
 * the instant it's made. This module closes the loop the Trading track asks for: after full-time, every call
 * is graded against TxLINE's *signed* final score, so "the Ear called it" becomes "the Ear called it, and
 * here's whether the pitch agreed." Nothing here is estimated — grades come only from the anchored result
 * feed, and a match that hasn't finalised stays ungraded rather than being scored as a miss.
 *
 * Grading is deterministic and non-inflating:
 *  - goal calls are matched to real goals in time order, consuming one remaining goal on the called side
 *    (a side-less / draw call consumes from whichever side still has one). Extra goal-calls with no goal
 *    left to claim are false positives. So a side that scored twice can confirm at most two goal-calls.
 *  - a full-time call is correct iff the feed finalised.
 *  - a stoppage (VAR / market-silence) cannot be verified from the score feed, so it is recorded but left
 *    out of the hit-rate — we never claim an accuracy we can't prove.
 */

export type GradedCall = {
  fixtureId: number;
  home?: string;
  away?: string;
  kind: "goal" | "stoppage" | "fulltime" | string;
  side: string | null;
  team: string | null;
  confidence: number;
  evidence: string;
  sig: string | null;
  ts: number;
  /** true = confirmed by the score, false = false positive, null = unverifiable (stoppage) or not yet graded. */
  correct: boolean | null;
  graded: boolean;
};

export type EarRecord = {
  goalCalls: number;
  goalConfirmed: number;
  goalHitRate: number | null;      // confirmed / graded goal calls, 0..1 (null until there is a graded goal call)
  fulltimeCalls: number;
  fulltimeConfirmed: number;
  stoppageCalls: number;
  gradedFixtures: number;
  pendingFixtures: number;         // finished-feed-not-yet-final or still live: calls awaiting a verdict
  onChain: number;                 // calls carrying a Solana signature
  totalCalls: number;
  updatedAt: number;
  feed: GradedCall[];              // recent calls, newest first — the deployable signal output
};

const empty: EarRecord = {
  goalCalls: 0, goalConfirmed: 0, goalHitRate: null, fulltimeCalls: 0, fulltimeConfirmed: 0,
  stoppageCalls: 0, gradedFixtures: 0, pendingFixtures: 0, onChain: 0, totalCalls: 0, updatedAt: 0, feed: [],
};

type RawCall = { fixture_id: number; kind: string; side: string | null; team: string | null; confidence: number; evidence: string; sig: string | null; ts: number };

/** The signed result for a fixture, coalesced + cached — the feed call is the slow part of a record build. */
function resultFor(fixtureId: number): Promise<MatchResult> {
  return cached(`ear-result:${fixtureId}`, { ttlMs: 60_000, swrMs: 300_000, staleMs: 3_600_000 }, () => matchResult(fixtureId));
}

/** Grade one fixture's calls (ascending ts) against its signed result. Pure given (calls, result). */
export function gradeFixture(calls: RawCall[], result: MatchResult): GradedCall[] {
  const asc = [...calls].sort((a, b) => a.ts - b.ts);
  const base = (c: RawCall): GradedCall => ({
    fixtureId: c.fixture_id, kind: c.kind, side: c.side, team: c.team,
    confidence: Number(c.confidence), evidence: c.evidence, sig: c.sig, ts: Number(c.ts), correct: null, graded: false,
  });
  if (!result.finished) return asc.map(base);            // no verdict until the feed finalises

  // Grade each side's goal calls against THAT side's real goals — a home-goal call is confirmed if the home
  // side scored (up to how many it scored), independently of away/draw calls. A "draw" call means the Ear
  // read a leveller (the draw becoming favoured), so it's confirmed only if the score was genuinely tied at
  // 1-1 or better at some point — walked from the real goal timeline, never assumed.
  const homeG = result.homeGoals || 0, awayG = result.awayGoals || 0;
  let hh = 0, aa = 0, leveller = false;
  for (const gl of result.goals) { if (gl.side === "home") hh++; else aa++; if (hh === aa && hh >= 1) leveller = true; }
  let homeSeen = 0, awaySeen = 0;
  return asc.map((c) => {
    const g = base(c);
    g.graded = true;
    if (c.kind === "goal") {
      if (c.side === "home") { homeSeen++; g.correct = homeSeen <= homeG; }
      else if (c.side === "away") { awaySeen++; g.correct = awaySeen <= awayG; }
      else if (c.side === "draw") { g.correct = leveller; }      // a leveller call: right iff the score was actually tied
      else g.correct = homeG + awayG > 0;                        // side-less goal call: a goal did happen
    } else if (c.kind === "fulltime") {
      g.correct = true;                                          // the feed finalised, which is what a full-time call claims
    } else {
      g.correct = null;                                          // stoppage: unverifiable from the score feed
    }
    return g;
  });
}

/** The whole track record, newest calls first. Read-only and honest: grades come only from finalised feeds. */
export async function earRecord(limitFeed = 24): Promise<EarRecord> {
  let rows: RawCall[];
  try {
    rows = (await db()`SELECT fixture_id, kind, side, team, confidence, evidence, sig, ts FROM ear_calls ORDER BY ts DESC`) as any[] as RawCall[];
  } catch {
    return { ...empty, updatedAt: Date.now() };
  }
  if (!rows.length) return { ...empty, updatedAt: Date.now() };

  const byFixture = new Map<number, RawCall[]>();
  for (const r of rows) { const k = Number(r.fixture_id); (byFixture.get(k) || byFixture.set(k, []).get(k)!).push(r); }

  const names = await fixtureNames([...byFixture.keys()]).catch(() => ({} as Record<string, { home: string; away: string }>));

  const graded: GradedCall[] = [];
  let gradedFixtures = 0, pendingFixtures = 0;
  for (const [fixtureId, calls] of byFixture) {
    const result = await resultFor(fixtureId).catch(() => ({ fixtureId, finished: false, homeGoals: null, awayGoals: null, goals: [] } as MatchResult));
    if (result.finished) gradedFixtures++; else pendingFixtures++;
    const nm = names[String(fixtureId)];
    for (const gc of gradeFixture(calls, result)) { if (nm) { gc.home = nm.home; gc.away = nm.away; } graded.push(gc); }
  }

  const goalCalls = graded.filter((g) => g.kind === "goal" && g.graded);
  const goalConfirmed = goalCalls.filter((g) => g.correct === true).length;
  const ftCalls = graded.filter((g) => g.kind === "fulltime" && g.graded);

  graded.sort((a, b) => b.ts - a.ts);
  return {
    goalCalls: goalCalls.length,
    goalConfirmed,
    goalHitRate: goalCalls.length ? goalConfirmed / goalCalls.length : null,
    fulltimeCalls: ftCalls.length,
    fulltimeConfirmed: ftCalls.filter((g) => g.correct === true).length,
    stoppageCalls: graded.filter((g) => g.kind === "stoppage").length,
    gradedFixtures,
    pendingFixtures,
    onChain: graded.filter((g) => g.sig).length,
    totalCalls: graded.length,
    updatedAt: Date.now(),
    feed: graded.slice(0, limitFeed),
  };
}

/** Per-fixture summary for the Live tab's Ear strip. */
export async function earRecordForFixture(fixtureId: number): Promise<{ goalCalls: number; goalConfirmed: number; finished: boolean; calls: GradedCall[] }> {
  let rows: RawCall[];
  try {
    rows = (await db()`SELECT fixture_id, kind, side, team, confidence, evidence, sig, ts FROM ear_calls WHERE fixture_id = ${fixtureId} ORDER BY ts DESC`) as any[] as RawCall[];
  } catch {
    return { goalCalls: 0, goalConfirmed: 0, finished: false, calls: [] };
  }
  const result = await resultFor(fixtureId).catch(() => ({ fixtureId, finished: false, homeGoals: null, awayGoals: null, goals: [] } as MatchResult));
  const calls = gradeFixture(rows, result).sort((a, b) => b.ts - a.ts);
  const goalCalls = calls.filter((c) => c.kind === "goal" && c.graded);
  return { goalCalls: goalCalls.length, goalConfirmed: goalCalls.filter((c) => c.correct === true).length, finished: result.finished, calls };
}
