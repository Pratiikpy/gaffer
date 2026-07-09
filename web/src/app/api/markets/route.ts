import { NextResponse } from "next/server";
import { listMarkets } from "@/lib/kernel";
import { fixtureNames } from "@/lib/fixtureNames";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open + settled pools, each carrying the real team names for its fixture. The names are joined from
 * the durable fixture cache rather than the live slate, so a pool on a finished match still labels
 * itself truthfully instead of falling back to "Home v Away" (audit #7). */
export async function GET() {
  try {
    // K7 — a room of fans all poll this at once. Coalesce them into one getProgramAccounts, and keep
    // serving the last good list through an RPC blip rather than showing everyone an error.
    const markets = await cached("markets", { ttlMs: 3000, swrMs: 30_000, staleMs: 60_000 }, listMarkets);
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
