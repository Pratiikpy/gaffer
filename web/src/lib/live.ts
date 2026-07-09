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
};

const cache = new Map<number, { at: number; v: LiveState }>();

/** Read the live state of a fixture. Cached briefly — the Live tab polls, TxLINE must not be hammered. */
export async function liveState(fixtureId: number): Promise<LiveState> {
  const hit = cache.get(fixtureId);
  if (hit && Date.now() - hit.at < 4_000) return hit.v;

  const empty: LiveState = { fixtureId, finished: false, clockSeconds: null, running: false, atHalftime: false, secondHalf: false };
  let v = empty;
  try {
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

      v = { fixtureId, finished, clockSeconds, running, atHalftime, secondHalf };
    }
  } catch { /* feed hiccup — an unknown state is "not at halftime", never a fabricated one */ }

  cache.set(fixtureId, { at: Date.now(), v });
  return v;
}
