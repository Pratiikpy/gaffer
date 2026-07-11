import "server-only";
import { txline } from "./txline";

export type Goal = { side: "home" | "away"; minute: number | null };
export type MatchResult = {
  fixtureId: number;
  finished: boolean;
  homeGoals: number | null;
  awayGoals: number | null;
  goals: Goal[];
  error?: string;
};

/** The ground truth a match actually produced, from TxLINE's signed feed. The final score and the goal
 * timeline (side + minute) are reconstructed from the `Stats` deltas across the anchored event stream.
 *
 * `finished` is false until the feed finalises (on the dev feed this stream stays empty during a live
 * match — which is exactly why the Ear reads the market mid-game and only grades off this afterwards).
 * A feed failure returns `error` set with everything null, so a caller can tell "feed is down" apart from
 * "match hasn't finished" — never a fabricated 0-0. Shared by /api/match-events (Ear grading) and
 * /api/grade-picks (the daily free-pick result), so both read the score the same way. */
export async function matchResult(fixtureId: number): Promise<MatchResult> {
  const empty = (error?: string): MatchResult =>
    ({ fixtureId, finished: false, homeGoals: null, awayGoals: null, goals: [], ...(error ? { error } : {}) });
  if (!fixtureId) return empty("no fixture");
  let events: any[];
  try {
    events = await txline().historicalEvents(fixtureId);
  } catch (e: any) {
    return empty((e?.message || "feed unavailable").slice(0, 80));
  }
  if (!events.length) return empty();

  const bySeq = [...events].sort((a, b) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));
  const finished = bySeq.some((e) => e.Action === "game_finalised") || Number(bySeq[bySeq.length - 1]?.StatusId) === 100;

  // Walk the stream; each rise in Stats[1]/[2] is a goal, stamped with the clock minute. A goal later
  // disallowed (VAR) shows as the count dropping back — pop it, so the timeline matches the final score.
  let pg1 = 0, pg2 = 0;
  const home: (number | null)[] = [], away: (number | null)[] = [];
  for (const e of bySeq) {
    const g1 = Number(e?.Stats?.[1] ?? pg1), g2 = Number(e?.Stats?.[2] ?? pg2);
    const min = e?.Clock?.Seconds != null ? Math.floor(Number(e.Clock.Seconds) / 60) : null;
    while (g1 > pg1) { home.push(min); pg1++; }
    while (g1 < pg1) { home.pop(); pg1--; }
    while (g2 > pg2) { away.push(min); pg2++; }
    while (g2 < pg2) { away.pop(); pg2--; }
  }
  const goals: Goal[] = [
    ...home.map((minute) => ({ side: "home" as const, minute })),
    ...away.map((minute) => ({ side: "away" as const, minute })),
  ].sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
  return { fixtureId, finished, homeGoals: pg1, awayGoals: pg2, goals };
}
