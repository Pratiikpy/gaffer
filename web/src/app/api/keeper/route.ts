import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/serverConfig";
import { listMarkets, listParlays } from "@/lib/kernel";
import { serverProgram, settleMarket, voidMarket, settleParlay, VOID_GRACE_SECS } from "@/lib/settleEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The unattended settler.
 *
 * The product's one promise is that the result itself releases the money — no operator in the loop who
 * *can* refuse you. Until now that was only true when somebody pressed a button, and the button lived
 * behind a dev flag that production never sets. So on the live site a pool would open, fans would stake,
 * the goal would go in, and nothing would pay. This route is what closes that gap: a scheduled sweep of
 * every open market and slip, cranking each one that the chain will now accept a proof for.
 *
 * It decides nothing. Every settle is a CPI into TxLINE's `validate_stat`, which re-verifies the Merkle
 * proof against anchored roots and hands back a bool. The keeper's only power is to *ask*, and to pay
 * the transaction fee for asking. A market whose predicate never came true is voided once past
 * `expiry + grace`, which refunds both sides rather than stranding the pot.
 *
 * Idempotent by construction: anything already settled reports `not open` and is skipped, so running it
 * twice a minute is harmless. Failures are per-item and never abort the sweep — one unprovable market
 * must not stop the pool next to it from paying.
 *
 * Two things call it. `agents/keeper-service.mjs` ticks every twenty seconds and is the actual settler
 * during a match. The Vercel cron in `vercel.json` is a once-a-day backstop — the Hobby plan allows
 * nothing faster — that mops up pools whose predicate never came true and anything missed while the
 * live keeper was down. Neither is privileged: cranking is permissionless, and anyone may do it.
 */
export async function GET(req: NextRequest) {
  return run(req);
}
/** POST as well, so a plain `curl -X POST` from an operator behaves identically to the cron's GET. */
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const startedAt = Date.now();

  try {
    const program = serverProgram();
    const now = Math.floor(Date.now() / 1000);
    const [markets, parlays] = await Promise.all([listMarkets(), listParlays()]);

    const settled: any[] = [], voided: any[] = [], slips: any[] = [], skipped: any[] = [];

    // Every open pool, every sweep — deliberately NOT gated on `lock_ts`.
    //
    // The moment a predicate is provably true, two things become true with it: the fans who called it
    // are owed their money, and anyone still able to stake is staking on a known result. Waiting for the
    // betting window to close would delay the first and permit the second. So we crank as soon as the
    // oracle has anchored a proof, which is exactly what "paid the second it happens" means. Pools on
    // matches that haven't kicked off cost nothing to try: `findProof` finds no events and caches the
    // miss for twenty seconds.
    const openMarkets = markets.filter((m: any) => m.status === 0);
    for (const m of openMarkets) {
      try {
        const r = await settleMarket(program, m.pubkey);
        if (r.settled) { settled.push({ market: m.pubkey, sig: r.sig, provenValue: r.provenValue }); continue; }

        // The predicate never held. Past expiry + grace, the honest move is a refund, not a stalemate.
        if (now >= Number(m.expiryTs) + VOID_GRACE_SECS) {
          const v = await voidMarket(program, m.pubkey);
          if (v.settled) { voided.push({ market: m.pubkey, sig: v.sig }); continue; }
          skipped.push({ market: m.pubkey, reason: v.reason });
          continue;
        }
        skipped.push({ market: m.pubkey, reason: r.reason });
      } catch (e: any) {
        skipped.push({ market: m.pubkey, reason: (e?.message || String(e)).slice(0, 90) });
      }
    }

    for (const p of parlays.filter((x: any) => x.status === 0)) {
      try {
        const r = await settleParlay(program, p.pubkey);
        if (r.settled) slips.push({ parlay: p.pubkey, outcome: r.outcome, sig: r.sig });
        else skipped.push({ parlay: p.pubkey, reason: r.reason });
      } catch (e: any) {
        skipped.push({ parlay: p.pubkey, reason: (e?.message || String(e)).slice(0, 90) });
      }
    }

    return NextResponse.json({
      ok: true,
      ms: Date.now() - startedAt,
      swept: { markets: openMarkets.length, parlays: parlays.filter((x: any) => x.status === 0).length },
      settled, voided, slips, skipped,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, ms: Date.now() - startedAt, error: (e?.message || String(e)).slice(0, 160) }, { status: 500 });
  }
}
