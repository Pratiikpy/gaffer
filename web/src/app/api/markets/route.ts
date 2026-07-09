import { NextResponse } from "next/server";
import { listMarkets } from "@/lib/kernel";
import { fixtureNames } from "@/lib/fixtureNames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open + settled pools, each carrying the real team names for its fixture. The names are joined from
 * the durable fixture cache rather than the live slate, so a pool on a finished match still labels
 * itself truthfully instead of falling back to "Home v Away" (audit #7). */
export async function GET() {
  try {
    const markets = await listMarkets();
    const names = await fixtureNames(markets.map((m: any) => m.fixtureId)).catch(() => ({} as Record<string, { home: string; away: string }>));
    const withNames = markets.map((m: any) => {
      const n = names[String(m.fixtureId)];
      return n ? { ...m, home: n.home, away: n.away } : m;
    });
    return NextResponse.json({ markets: withNames });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
