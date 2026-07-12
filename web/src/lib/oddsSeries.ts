import "server-only";
import { db } from "./db";

/** THE SWING — the match read from the market's own movement.
 *
 * Every other app draws a momentum graph from event data (shots, attacks). We draw one from the de-margined
 * betting line: when the market lurches toward a side, that side is on top — a goal, a red card, a spell of
 * pressure the book is pricing in real time. This is the one nameable number we own — "Argentina +23" means
 * the market has moved 23 points their way since kickoff — plus the bar graph fans screenshot.
 *
 * The series is sampled lazily off the live-odds read (bucketed so a hot path stays cheap), and pruned so a
 * fixture never keeps more than a couple of hours of line. Everything here is best-effort: a DB hiccup must
 * never break the odds read it hangs off.
 */

const BUCKET_MS = 14_000;   // one sample per fixture per ~14s, no matter how many readers
const KEEP = 240;           // ~1h of 14s samples

let ensured = false;
async function ensure() {
  if (ensured) return;
  await db()`CREATE TABLE IF NOT EXISTS odds_series (
    fixture_id bigint NOT NULL, ts bigint NOT NULL,
    home int, draw int, away int,
    PRIMARY KEY (fixture_id, ts))`;
  ensured = true;
}

/** Append a sample if the last one for this fixture is older than the bucket. Best-effort. */
export async function sampleOdds(fixtureId: number, o: { home: number | null; draw: number | null; away: number | null }) {
  if (!fixtureId || o.home == null || o.away == null) return;
  try {
    await ensure();
    const now = Date.now();
    const last = (await db()`SELECT ts FROM odds_series WHERE fixture_id = ${fixtureId} ORDER BY ts DESC LIMIT 1`) as any[];
    if (last.length && now - Number(last[0].ts) < BUCKET_MS) return;
    await db()`INSERT INTO odds_series (fixture_id, ts, home, draw, away) VALUES (${fixtureId}, ${now}, ${o.home}, ${o.draw ?? null}, ${o.away})
      ON CONFLICT (fixture_id, ts) DO NOTHING`;
    // prune anything past the last KEEP samples for this fixture
    await db()`DELETE FROM odds_series WHERE fixture_id = ${fixtureId} AND ts < (
      SELECT MIN(ts) FROM (SELECT ts FROM odds_series WHERE fixture_id = ${fixtureId} ORDER BY ts DESC LIMIT ${KEEP}) q)`;
  } catch { /* never break the odds read */ }
}

export type SwingPoint = { ts: number; home: number; draw: number | null; away: number; dHome: number };
export type Swing = {
  series: SwingPoint[];
  /** net implied-% shift toward home since the series began (signed: + = home, − = away). */
  net: number;
  /** which side the net swing favours, and by how much (absolute). */
  leader: "home" | "away" | "level";
  lead: number;
  /** short-term momentum: net of the last few intervals. */
  recent: number;
  /** total absolute movement — "how dramatic has it been", 0..∞ (a quotable intensity). */
  intensity: number;
  samples: number;
};

const empty: Swing = { series: [], net: 0, leader: "level", lead: 0, recent: 0, intensity: 0, samples: 0 };

/** Compute THE SWING for a fixture from its stored line. */
export async function swing(fixtureId: number): Promise<Swing> {
  if (!fixtureId) return empty;
  let rows: any[];
  try {
    await ensure();
    rows = (await db()`SELECT ts, home, draw, away FROM odds_series WHERE fixture_id = ${fixtureId} ORDER BY ts ASC LIMIT ${KEEP}`) as any[];
  } catch {
    return empty;
  }
  if (rows.length < 2) return { ...empty, samples: rows.length, series: rows.map((r) => ({ ts: Number(r.ts), home: Number(r.home), draw: r.draw == null ? null : Number(r.draw), away: Number(r.away), dHome: 0 })) };

  const series: SwingPoint[] = [];
  let prevHome = Number(rows[0].home);
  for (let i = 0; i < rows.length; i++) {
    const home = Number(rows[i].home);
    const dHome = i === 0 ? 0 : home - prevHome;
    series.push({ ts: Number(rows[i].ts), home, draw: rows[i].draw == null ? null : Number(rows[i].draw), away: Number(rows[i].away), dHome });
    prevHome = home;
  }
  const net = series[series.length - 1].home - series[0].home;
  const recent = series.slice(-5).reduce((a, p) => a + p.dHome, 0);
  const intensity = series.reduce((a, p) => a + Math.abs(p.dHome), 0);
  const leader = net > 1.5 ? "home" : net < -1.5 ? "away" : "level";
  return { series, net: Math.round(net), leader, lead: Math.round(Math.abs(net)), recent: Math.round(recent), intensity: Math.round(intensity), samples: series.length };
}
