import { NextRequest, NextResponse } from "next/server";
import { earRecord, earRecordForFixture } from "@/lib/earRecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Gaffer's Ear's graded track record — its market-reads scored against TxLINE's signed final scores.
 *
 * This is both the in-app "track record" strip and a clean machine-readable signal feed a trading desk
 * could poll: every call carries its kind, side, confidence, on-chain signature, and — once the match has
 * finalised — whether the score confirmed it. `?fixture=<id>` narrows to one match; no arg returns the
 * whole record plus the recent-call feed. Read-only; grades are never fabricated (an unfinalised match
 * stays ungraded). */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  try {
    if (fixtureId) return NextResponse.json(await earRecordForFixture(fixtureId));
    return NextResponse.json(await earRecord());
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
