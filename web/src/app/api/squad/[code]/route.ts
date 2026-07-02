import { NextRequest, NextResponse } from "next/server";
import { getSquad } from "@/lib/squadStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const sq = await getSquad(code);
  if (!sq) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ squad: sq });
}
