import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { txline } from "@/lib/txline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Q8 — which matches can actually be relived.
 *
 * "Any finished game" means any game we have a real tick stream for, not merely whatever is on today's
 * slate. We remember every fixture we have ever seen (fixture_names), so this checks the most recent of
 * them for a finished stream and reports the ones that can carry a run. Cached, because each check is a
 * feed call and the answer changes only when a match ends.
 */
let cache: { at: number; v: { fixtureId: number; home: string; away: string }[] } | null = null;
const TTL = 5 * 60_000;
const MAX_CHECK = 8;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json({ matches: cache.v });
  try {
    const rows = await db()`SELECT fixture_id, home, away FROM fixture_names ORDER BY fixture_id DESC LIMIT ${MAX_CHECK}`;
    const out: { fixtureId: number; home: string; away: string }[] = [];
    for (const r of rows as any[]) {
      const id = Number(r.fixture_id);
      try {
        const events = await txline().historicalEvents(id);
        const finished = events.some((e: any) => e.Action === "game_finalised");
        const hasGoals = events.some((e: any) => e.Action === "goal");
        if (finished && hasGoals) out.push({ fixtureId: id, home: r.home, away: r.away });
      } catch { /* a fixture with no stream simply isn't relivable */ }
    }
    cache = { at: Date.now(), v: out };
    return NextResponse.json({ matches: out });
  } catch {
    return NextResponse.json({ matches: [] });
  }
}
