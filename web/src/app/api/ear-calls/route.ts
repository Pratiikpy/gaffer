import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Gaffer's Ear's live feed for a fixture — the events it read from the market, newest first, each
 * with its on-chain Memo signature. Powers the in-app Ear strip. Read-only; the agent writes via
 * /api/commit-ear. Empty (never an error) when there are no calls or the table isn't there yet. */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ calls: [] });
  try {
    const rows = await db()`SELECT kind, side, team, confidence, evidence, sig, ts
      FROM ear_calls WHERE fixture_id = ${fixtureId} ORDER BY ts DESC LIMIT 12`;
    const calls = (rows as any[]).map((r) => ({
      kind: r.kind, side: r.side, team: r.team, confidence: Number(r.confidence),
      evidence: r.evidence, sig: r.sig, ts: Number(r.ts),
    }));
    return NextResponse.json({ calls });
  } catch {
    return NextResponse.json({ calls: [] });
  }
}
