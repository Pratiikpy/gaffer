/** Live-match state derived from the real TxLINE event stream.
 *
 * What the feed actually gives us (verified against fixture 18193785, not assumed):
 *   Clock    : { Running: boolean, Seconds: number }   — seconds elapsed, running only while in play
 *   StatusId : 4 while the clock runs (BOTH halves), 5 while it is stopped, 100 once finalised
 *   Action   : "kickoff" | "goal" | "standby" | "game_finalised" | …
 *
 * StatusId therefore cannot tell a half apart on its own. Halftime is read the only way the data
 * supports: the clock has STOPPED somewhere in the 45–50 minute band and the match is not finished.
 * We never invent a period the feed didn't give us.
 */
import "server-only";
import { txline } from "./txline";
import { cached } from "./cache";

export const HALF_MS = 45 * 60;                 // seconds
export const HT_WINDOW: [number, number] = [45 * 60, 50 * 60]; // 2700..3000s — stoppage lives in here
export const HT_BEAT_MS = 60_000;               // the beat fires a minute into the break

export type LiveState = {
  fixtureId: number;
  finished: boolean;
  clockSeconds: number | null;
  running: boolean;
  atHalftime: boolean;
  secondHalf: boolean;
  /** The scoreline, read off the newest event that actually carried one. `null` when the feed has not
   *  reported stats yet — an unknown score is shown as unknown, never as 0–0. */
  homeGoals: number | null;
  awayGoals: number | null;
};

/** A fixture we know nothing about. Distinct from a fixture whose feed call FAILED — see below. */
export const emptyLiveState = (fixtureId: number): LiveState =>
  ({ fixtureId, finished: false, clockSeconds: null, running: false, atHalftime: false, secondHalf: false, homeGoals: null, awayGoals: null });

/** Read the live state of a fixture. Single-flighted: a squad polling together must cost ONE feed call,
 * not one per phone. A stale-but-recent state beats an error while the feed catches its breath. */
export async function liveState(fixtureId: number): Promise<LiveState> {
  return cached(`live:${fixtureId}`, { ttlMs: 4_000, swrMs: 30_000, staleMs: 60_000 }, () => readLiveState(fixtureId));
}

/** Throws when the feed call fails. That distinction is the whole point.
 *
 * This used to swallow the error and hand back an empty state — which `cached()` then stored as though
 * it were data, for up to thirty seconds. So one cold start or one blip and the scoreline silently blanked
 * out, exactly when a fan is watching a match. `cache.ts` promises never to cache an error; converting an
 * error into a plausible-looking value here is how that promise got broken.
 *
 * Throwing lets the cache do its job: serve the last good scoreline through a hiccup, and only surface
 * failure when there is nothing good left to serve. An empty state is now returned for one reason only —
 * the feed answered, and it has nothing on this fixture yet.
 */
async function readLiveState(fixtureId: number): Promise<LiveState> {
  let v = emptyLiveState(fixtureId);
  {
    const events: any[] = await txline().historicalEvents(fixtureId);
    if (events.length) {
      const bySeq = [...events].sort((a, b) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));
      const last = bySeq[bySeq.length - 1];
      const finished = bySeq.some((e) => e.Action === "game_finalised") || Number(last?.StatusId) === 100;

      // The newest event that actually carried a clock reading — many events (status, disconnects) don't.
      const withClock = [...bySeq].reverse().find((e) => typeof e?.Clock?.Seconds === "number" && e.Clock.Seconds >= 0);
      const clockSeconds = withClock ? Number(withClock.Clock.Seconds) : null;
      const running = !!withClock?.Clock?.Running && !finished;

      const inBand = clockSeconds != null && clockSeconds >= HT_WINDOW[0] && clockSeconds <= HT_WINDOW[1];
      const atHalftime = !finished && !running && inBand;
      const secondHalf = clockSeconds != null && clockSeconds > HT_WINDOW[1];

      // Stat 1 = home goals, stat 2 = away goals. Most events carry no Stats block at all, so walk back
      // to the newest one that does. A genuine 0–0 reports `{"1": 0}`; a match with no data reports
      // nothing — and those two must never render the same way.
      const withStats = [...bySeq].reverse().find((e) => e?.Stats && e.Stats["1"] != null);
      const homeGoals = withStats ? Number(withStats.Stats["1"]) : null;
      const awayGoals = withStats ? Number(withStats.Stats["2"] ?? 0) : null;

      v = { fixtureId, finished, clockSeconds, running, atHalftime, secondHalf, homeGoals, awayGoals };
    }
  }
  return v;
}
