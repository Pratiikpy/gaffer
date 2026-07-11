import "server-only";
import { txline } from "./txline";
import { cached } from "./cache";

/** When a match is over, in unix seconds — the moment a pool on it should stop caring.
 *
 * This exists because of a constraint `settle_no` cannot escape. Proving a goal *never came* means
 * proving `value <= threshold` at a snapshot taken after the market closed; a snapshot from minute three
 * proves nothing. The kernel therefore refuses any proof with `ts < expiry_ts`.
 *
 * So a pool whose expiry sits a week in the future can never settle NO: the feed stops emitting at the
 * final whistle, and no snapshot will ever carry a timestamp that late. Every pool we minted had a
 * seven-day expiry, which quietly made the NO side unresolvable — the very thing `settle_no` was written
 * to fix. A pool has to expire when the match does.
 *
 * Ninety minutes, fifteen of half-time, and a generous stoppage allowance. Erring long is safe: the
 * kernel only needs *some* anchored snapshot at or after expiry, and the feed keeps talking until the
 * game is finalised. Erring short would let a pool settle NO while the ball was still in play.
 */
export const MATCH_LENGTH_SECS = 135 * 60;

/** `null` when we cannot say — an unknown fixture, or a feed that has told us nothing about it. */
export async function matchEndSecs(fixtureId: number): Promise<number | null> {
  return cached(`matchend:${fixtureId}`, { ttlMs: 5 * 60_000, swrMs: 30 * 60_000, staleMs: 60 * 60_000 },
    () => readMatchEnd(fixtureId));
}

async function readMatchEnd(fixtureId: number): Promise<number | null> {
  // A scheduled match: kickoff plus the length of a match.
  try {
    const schedule = await txline().fixturesSnapshot();
    const f = schedule.find((x: any) => Number(x.FixtureId) === fixtureId);
    const startMs = Number(f?.StartTime ?? f?.startTime ?? 0);
    if (startMs > 0) return Math.floor(startMs / 1000) + MATCH_LENGTH_SECS;
  } catch { /* fall through to the feed */ }

  // A match the schedule has forgotten — or a schedule that is momentarily down (both look like an empty
  // snapshot). Fall back to the feed, but ONLY for a match the feed says is FINISHED: the last event's
  // timestamp is the final whistle then. For a live match that same timestamp is the current minute, so
  // taking it as "match end" would expire a pool mid-game. A running match with no schedule row is
  // reported as unknown, and `expiryForFixture` gives it a safe long window instead of a mid-match one.
  try {
    const events: any[] = await txline().historicalEvents(fixtureId);
    if (events.length) {
      const bySeq = [...events].sort((a, b) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));
      const finished = bySeq.some((e) => e.Action === "game_finalised") || Number(bySeq[bySeq.length - 1]?.StatusId) === 100;
      if (finished) {
        const last = [...bySeq].reverse().find((e) => Number(e?.Ts ?? e?.ts) > 0);
        const ts = Number(last?.Ts ?? last?.ts ?? 0);
        if (ts > 0) return Math.floor(ts / 1000);
      }
    }
  } catch { /* nothing to say */ }

  return null;
}

/** Can the NO side of this market ever be proven?
 *
 * Only if a snapshot exists — or will exist — from at or after the pool's expiry. That is true exactly
 * when the pool expires no later than the match it is about. A pool on a finished match, minted today
 * with a future expiry, can never satisfy it: the feed went quiet hours ago. Those pools are honest
 * YES-or-refund pools, and the app must say so rather than quote NO a payout it cannot deliver.
 */
export async function noResolvable(fixtureId: number, expiryTs: number): Promise<boolean> {
  const end = await matchEndSecs(fixtureId).catch(() => null);
  if (end === null) return false;
  return expiryTs <= end;
}

/** The expiry a new pool on this fixture should carry. Falls back to a week when the match is unknown. */
export async function expiryForFixture(fixtureId: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const end = await matchEndSecs(fixtureId).catch(() => null);

  // A match still to finish: the pool closes when it does.
  if (end !== null && end > now + 300) return end;

  // A match already over cannot be given a valid past expiry — `create_market` requires one in the
  // future — so a pool on it can never prove its NO side, and nothing it says will ever come true that
  // has not already. Such a pool exists only to be settled YES immediately or refunded. Give it a short
  // life: the keeper settles a true predicate on its next sweep, and anything else voids an hour later
  // and returns everyone's stake.
  //
  // It used to get a week. Thirteen pools accumulated on the demo match in a single afternoon of
  // testing, unsettleable and unvoidable, cluttering the board for seven days apiece.
  if (end !== null) return now + FINISHED_MATCH_WINDOW_SECS;

  // A fixture the feed has never heard of. Long enough to be useful, short enough to expire.
  return now + 24 * 3600;
}

/** How long a pool on an already-finished match stays open before it can be refunded. */
export const FINISHED_MATCH_WINDOW_SECS = 15 * 60;
