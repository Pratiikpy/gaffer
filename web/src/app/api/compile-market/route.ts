import { NextRequest, NextResponse } from "next/server";
import { compileMarket } from "@/lib/compileMarket";
import { ogConfigured } from "@/lib/og";
import { txline } from "@/lib/txline";
import { fixtureNames } from "@/lib/fixtureNames";
import { cached } from "@/lib/cache";
import { listMarkets } from "@/lib/kernel";
import { expiryForFixture } from "@/lib/matchWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Compile a fan's sentence into a pool they can then mint themselves.
 *
 * This route never touches the chain and never spends the server's keypair. It answers one question —
 * "is this a legal, not-yet-true market?" — and hands the predicate back for the fan's own wallet to
 * sign. That is deliberate: user-generated markets must not become a way to drain our wallet, and the
 * person who wants the pool is the person who should pay its rent.
 */

// Inference costs money and the model is the slow part. A fan asking a question is fine; a script asking
// six hundred is not.
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now(), win = hits.get(ip)?.filter((t) => now - t < 60_000) ?? [];
  if (win.length >= 6) { hits.set(ip, win); return true; }
  win.push(now); hits.set(ip, win); return false;
}

/** The stat's value in the feed right now — the veto on markets that have already happened.
 *  `null` when the feed has nothing on this fixture (a match yet to kick off), which vetoes nothing. */
async function currentStat(fixtureId: number, statKey: number): Promise<number | null> {
  // This feeds the already-true veto, so it must be near-fresh: a long stale-while-revalidate window here
  // could serve a pre-goal count and wave through a predicate that has, in reality, just come true. Keep
  // this layer's staleness to a few seconds (the underlying feed read has its own short cache).
  const stats = await cached(`finalstats:${fixtureId}`, { ttlMs: 2_000, swrMs: 3_000, staleMs: 8_000 }, async () => {
    const events: any[] = await txline().historicalEvents(fixtureId);
    const withStats = [...events].reverse().find((e) => e?.Stats && e.Stats["1"] != null);
    return (withStats?.Stats ?? null) as Record<string, number> | null;
  });
  if (!stats) return null;
  const v = stats[String(statKey)];
  return typeof v === "number" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    if (!ogConfigured()) return NextResponse.json({ ok: false, reason: "Asking your own question isn't switched on yet." }, { status: 503 });

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (throttled(ip)) return NextResponse.json({ ok: false, reason: "One at a time — give it a second." }, { status: 429 });

    const body = await req.json().catch(() => ({}));
    const text = String(body?.text ?? "");
    const fixtureId = Number(body?.fixtureId) || 0;
    if (!fixtureId) return NextResponse.json({ ok: false, reason: "Pick a match first." }, { status: 400 });

    // The fixture must be one the feed actually carries; otherwise nothing could ever settle it.
    const names = await fixtureNames([String(fixtureId)]).catch(() => ({} as Record<string, { home: string; away: string }>));
    const n = names[String(fixtureId)];
    if (!n) return NextResponse.json({ ok: false, reason: "I don't know that match." }, { status: 400 });

    const result = await compileMarket({
      text,
      home: n.home,
      away: n.away,
      // Let a genuine feed failure THROW — compileMarket fails the already-true veto closed on a throw.
      // Swallowing it to null here would read a feed blip as "match not started" and let an already-true
      // pool be minted. currentStat still returns null for the real no-data case (match not started).
      currentValueFor: (statKey) => currentStat(fixtureId, statKey),
    });

    if (!result.ok) return NextResponse.json(result);

    // The same question, twice, is two pools splitting one room's money — and it reads as a bug on the
    // board. If it is already open, send the fan to it instead of minting a rival.
    const existing = await cached("markets", { ttlMs: 3000, swrMs: 30_000, staleMs: 60_000 }, listMarkets)
      .then((ms: any[]) => ms.find((m) =>
        m.status === 0 &&
        Number(m.fixtureId) === fixtureId &&
        m.statKey === result.predicate.statKey &&
        m.threshold === result.predicate.threshold))
      .catch(() => null);
    if (existing) {
      return NextResponse.json({ ok: false, reason: `“${result.question}” is already open — back it below.` });
    }

    return NextResponse.json({
      ok: true,
      question: result.question,
      team: result.team,
      fixtureId,
      // The pool must expire when the match does, or its NO side can never be proven.
      expiryTs: await expiryForFixture(fixtureId),
      // Exactly the arguments `create_market` takes. The browser signs it; we never do.
      market: {
        statKey: result.predicate.statKey,
        period: result.predicate.period,
        threshold: result.predicate.threshold,
        comparison: result.predicate.comparison,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, reason: "That didn't go through — try again." }, { status: 500 });
  }
}
