import { NextRequest, NextResponse } from "next/server";
import { swing } from "@/lib/oddsSeries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** THE SWING — the match read from the market's own movement, for a fixture. Returns the sampled line
 * series plus the one nameable number we own (net implied-% shift toward home, its leader, short-term
 * momentum, and total intensity). Read-only; the series is sampled off the live-odds read. */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });
  try {
    return NextResponse.json(await swing(fixtureId));
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
