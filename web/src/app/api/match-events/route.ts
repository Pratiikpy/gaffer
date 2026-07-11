import { NextRequest, NextResponse } from "next/server";
import { txline } from "@/lib/txline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ground truth a match actually produced, from TxLINE's signed feed — used to grade The Gaffer's Ear
 * after full-time. Returns the final score and the goal timeline (side + minute), reconstructed from the
 * `Stats` deltas across the anchored event stream. `finished` is false until the feed finalises (during a
 * live match on the dev feed this stream is empty, which is exactly why the Ear reads the market instead). */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });
  try {
    const events: any[] = await txline().historicalEvents(fixtureId);
    if (!events.length) return NextResponse.json({ fixtureId, finished: false, homeGoals: null, awayGoals: null, goals: [] });

    const bySeq = [...events].sort((a, b) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));
    const finished = bySeq.some((e) => e.Action === "game_finalised") || Number(bySeq[bySeq.length - 1]?.StatusId) === 100;

    // Walk the stream; each rise in Stats[1]/[2] is a goal, stamped with the clock minute. A goal that is
    // later disallowed (VAR) shows as the count dropping back — pop it, so the timeline matches the final
    // score rather than leaving a phantom.
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
    const goals = [
      ...home.map((minute) => ({ side: "home" as const, minute })),
      ...away.map((minute) => ({ side: "away" as const, minute })),
    ].sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
    return NextResponse.json({ fixtureId, finished, homeGoals: pg1, awayGoals: pg2, goals });
  } catch {
    return NextResponse.json({ fixtureId, finished: false, homeGoals: null, awayGoals: null, goals: [] }, { status: 200 });
  }
}
