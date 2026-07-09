import { NextResponse } from "next/server";
import { txline } from "@/lib/txline";
import { rememberFixtures } from "@/lib/fixtureNames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MATCH_MS = 2.5 * 3600_000; // a match + stoppage/HT window
let cache: { at: number; v: any[] } | null = null;

/** Today's real match schedule from TxLINE, normalized with a live/soon/upcoming/finished state so the
 * app can lead with what's actually on right now instead of a hardcoded fixture. */
export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > 60_000) {
      const raw = await txline().fixturesSnapshot();
      const now = Date.now();
      const list = raw.map((f: any) => {
        const start = Number(f.StartTime);
        const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
        const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
        const state = now >= start && now < start + MATCH_MS ? "live" : now >= start + MATCH_MS ? "finished" : start - now < 6 * 3600_000 ? "soon" : "upcoming";
        return { fixtureId: Number(f.FixtureId), home: f.Participant1, away: f.Participant2, homeTeam: home, awayTeam: away, competition: f.Competition, startTime: start, state };
      }).sort((a: any, b: any) => a.startTime - b.startTime);
      cache = { at: now, v: list };
      // Remember these names forever: pools outlive the slate, and a money card must never say
      // "Home v Away". Fire-and-forget — a naming cache must never break the schedule.
      rememberFixtures(list).catch(() => {});
    }
    return NextResponse.json({ fixtures: cache.v });
  } catch {
    return NextResponse.json({ fixtures: [] });
  }
}
