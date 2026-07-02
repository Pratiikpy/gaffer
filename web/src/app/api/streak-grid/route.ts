import { NextRequest, NextResponse } from "next/server";
import { streakGrid } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Y2 — the shareable emoji streak grid (server-derived from the activity ledger). */
export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") || "";
  if (!user) return NextResponse.json({ cells: [], streak: 0, alivePct: null });
  return NextResponse.json(await streakGrid(user));
}
