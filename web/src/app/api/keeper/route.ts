import { NextRequest, NextResponse } from "next/server";
import { adminOk, secretEq } from "@/lib/serverConfig";
import { listMarkets, listParlays, windowedMarketPubkeys } from "@/lib/kernel";
import { serverProgram, settleMarket, settleMarketNo, voidMarket, settleParlay, RESOLVE_GRACE_SECS } from "@/lib/settleEngine";

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
  // Cranking is permissionless in spirit (the chain re-verifies every proof), but the fee spend is gated:
  // the daily cron / an operator via adminOk, OR the deployed agent host via its own secret — which is how
  // the worker pokes this the moment a match finishes, so pools settle in minutes, not on the daily cron.
  const agentOk = secretEq(req.headers.get("x-ear-key") || "", process.env.EAR_COMMIT_SECRET || "");
  if (!agentOk && !adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const startedAt = Date.now();

  // Optional `?fixture=` — sweep one match instead of the whole chain.
  //
  // A full sweep walks every open pool ever minted, including dead ones whose feed has aged out and
  // answers 403 on every tick. That is fine for the nightly cron and far too slow during a match: the
  // promise is that a goal pays before the replay finishes, not a minute later. On match day the keeper
  // watches the match.
  const only = Number(req.nextUrl.searchParams.get("fixture")) || 0;

  try {
    const program = serverProgram();
    const now = Math.floor(Date.now() / 1000);
    const [allMarkets, allParlays] = await Promise.all([listMarkets(), listParlays()]);
    const markets = only ? allMarkets.filter((m: any) => Number(m.fixtureId) === only) : allMarkets;
    const parlays = only ? allParlays.filter((p: any) => Number(p.fixtureId) === only) : allParlays;

    // `skipped` is benign — a predicate the chain can't prove yet (no anchored proof, not expired). `errored`
    // is a market/slip whose settle attempt THREW (RPC down, a proof the kernel keeps rejecting): a stuck
    // payout the agents must surface, not a quiet no-op. Keeping them apart is what lets the keeper log shout
    // on a real failure instead of drowning it in "not provable yet" heartbeats.
    const settled: any[] = [], voided: any[] = [], slips: any[] = [], skipped: any[] = [], errored: any[] = [];

    // Every open pool, every sweep — deliberately NOT gated on `lock_ts`.
    //
    // The moment a predicate is provably true, two things become true with it: the fans who called it
    // are owed their money, and anyone still able to stake is staking on a known result. Waiting for the
    // betting window to close would delay the first and permit the second. So we crank as soon as the
    // oracle has anchored a proof, which is exactly what "paid the second it happens" means. Pools on
    // matches that haven't kicked off cost nothing to try: `findProof` finds no events and caches the
    // miss for twenty seconds.
    // Windowed markets carry a DELTA predicate; the generic settle path below proves the ABSOLUTE stat and
    // would mis-settle them (fire YES on the absolute count, and there is no NO payout for a delta). Route
    // them away from this ladder entirely — they settle only through /api/settle-window. On a lookup error
    // this is an empty set and the ladder proceeds as before: no window market is creatable via any prod
    // route today, so this is belt-and-braces for the day one is.
    const windowed = await windowedMarketPubkeys(program).catch(() => new Set<string>());

    const openMarkets = markets.filter((m: any) => m.status === 0);
    for (const m of openMarkets) {
      if (windowed.has(m.pubkey)) { skipped.push({ market: m.pubkey, reason: "windowed — settles via settle-window" }); continue; }
      try {
        // The ladder, in the order the chain allows it.
        //  1. Did it happen?  -> settle, YES takes the pot.
        //  2. Is it over, and provably didn't happen? -> settle_no, NO takes the pot.
        //  3. Neither provable after an hour? -> void, everybody is repaid.
        // Step 2 is the one that makes the pool two-sided. Before it existed, a NO backer could only
        // lose or break even, and the app was quoting them a payout the kernel could not deliver.
        const r = await settleMarket(program, m.pubkey);
        if (r.settled) { settled.push({ market: m.pubkey, sig: r.sig, provenValue: r.provenValue, outcome: r.outcome }); continue; }

        const n = await settleMarketNo(program, m.pubkey);
        if (n.settled) { settled.push({ market: m.pubkey, sig: n.sig, provenValue: n.provenValue, outcome: n.outcome }); continue; }

        if (now >= Number(m.expiryTs) + RESOLVE_GRACE_SECS) {
          const v = await voidMarket(program, m.pubkey);
          if (v.settled) { voided.push({ market: m.pubkey, sig: v.sig }); continue; }
          skipped.push({ market: m.pubkey, reason: v.reason });
          continue;
        }
        skipped.push({ market: m.pubkey, reason: r.reason, no: n.reason });
      } catch (e: any) {
        errored.push({ market: m.pubkey, reason: (e?.message || String(e)).slice(0, 90) });
      }
    }

    for (const p of parlays.filter((x: any) => x.status === 0)) {
      try {
        const r = await settleParlay(program, p.pubkey);
        if (r.settled) slips.push({ parlay: p.pubkey, outcome: r.outcome, sig: r.sig });
        else skipped.push({ parlay: p.pubkey, reason: r.reason });
      } catch (e: any) {
        errored.push({ parlay: p.pubkey, reason: (e?.message || String(e)).slice(0, 90) });
      }
    }

    return NextResponse.json({
      ok: true,
      ms: Date.now() - startedAt,
      fixture: only || null,
      swept: { markets: openMarkets.length, parlays: parlays.filter((x: any) => x.status === 0).length },
      paid: settled.length + voided.length + slips.length,
      settled, voided, slips, skipped, errored,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, ms: Date.now() - startedAt, error: (e?.message || String(e)).slice(0, 160) }, { status: 500 });
  }
}
