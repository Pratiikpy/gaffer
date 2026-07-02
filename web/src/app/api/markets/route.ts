import { NextResponse } from "next/server";
import { listMarkets } from "@/lib/kernel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const markets = await listMarkets();
    return NextResponse.json({ markets });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
