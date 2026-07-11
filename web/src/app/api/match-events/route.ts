import { NextRequest, NextResponse } from "next/server";
import { matchResult } from "@/lib/matchResult";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ground truth a match actually produced, from TxLINE's signed feed — used to grade The Gaffer's Ear
 * after full-time. Returns the final score and the goal timeline (side + minute). `finished` is false until
 * the feed finalises; on a feed failure `error` is set (with everything null) so the Ear can tell a feed
 * outage apart from "match still live" instead of reading it as a benign not-done. */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });
  const r = await matchResult(fixtureId);
  return NextResponse.json(r, { status: r.error ? 502 : 200 });
}
