import { NextResponse } from "next/server";
import { listMarkets } from "@/lib/kernel";
import { fixtureNames } from "@/lib/fixtureNames";
import { cached } from "@/lib/cache";
import { matchEndSecs } from "@/lib/matchWindow";

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
    // Whether the NO side of each pool can ever be proven. `settle_no` needs a snapshot from at or after
    // the pool's expiry, so a pool that outlives its match can never resolve NO — and the app must not
    // quote NO a payout it cannot deliver. One match-end lookup per fixture; the comparison is per pool,
    // because two pools on the same match can carry different expiries.
    const ends = new Map<number, number | null>();
    await Promise.all([...new Set(markets.map((m: any) => Number(m.fixtureId)))].map(async (f) => {
      ends.set(f, await matchEndSecs(f).catch(() => null));
    }));

    const withNames = markets.map((m: any) => {
      const n = names[String(m.fixtureId)];
      const end = ends.get(Number(m.fixtureId)) ?? null;
      const base = { ...m, noResolvable: end !== null && Number(m.expiryTs) <= end };
      return n ? { ...base, home: n.home, away: n.away } : base;
    });
    return NextResponse.json({ markets: withNames });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
