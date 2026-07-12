import { NextRequest, NextResponse } from "next/server";
import { txline } from "@/lib/txline";
import { sampleOdds } from "@/lib/oddsSeries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The market's current consensus line for a fixture (server proxies TxLINE; token never reaches the
 * browser). Powers Fans vs the Market (G1): the crowd's pool split vs the market's de-margined implied %. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await params;
  const id = Number(fixtureId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "unknown match" }, { status: 400 });
  try {
    const snap = await txline().oddsSnapshot(id);
    // The de-margined 1X2 row carries Pct = [home%, draw%, away%]. Prefer the full-match line over a
    // half market; empty snapshot is a valid "market not open yet" state (the match hasn't gone live).
    const is1x2 = (o: any) => /1X2/i.test(String(o?.SuperOddsType || ""));
    const isFull = (o: any) => !/half=/.test(String(o?.MarketPeriod || ""));
    const row = snap.find((o: any) => is1x2(o) && isFull(o)) || snap.find(is1x2) || null;
    const pct: any[] = Array.isArray(row?.Pct) ? row.Pct : [];
    const num = (x: any) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : null; };
    const home = num(pct[0]), draw = num(pct[1]), away = num(pct[2]);
    // Feed THE SWING: sample the live line into the series (bucketed + best-effort, never blocks the read).
    if (pct.length >= 3) void sampleOdds(id, { home, draw, away });
    return NextResponse.json({ fixtureId: id, hasOdds: pct.length >= 3, home, draw, away, count: snap.length });
  } catch {
    return NextResponse.json({ fixtureId: id, hasOdds: false, home: null, draw: null, away: null, count: 0 });
  }
}
