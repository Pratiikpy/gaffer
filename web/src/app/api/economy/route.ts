import { NextRequest, NextResponse } from "next/server";
import { tokenOk, pointsTotal, computeStreak } from "@/lib/points";
import {
  lifetimeEarned, tierFor, weeklyLeague, percentileToday, medalFor, dailyQuests, weeklyBoard,
  getWager, openWager, resolveWager, checkMilestone, earnBack, rolloverPot,
  boosterState, useMove, useMystery, biggestWins, foresight, WAGER, MILESTONES, TIERS, saveStamp, getStamp,
  enterKnockouts, knockoutBoard, MYSTERY_NAME, MYSTERY_BLURB,
} from "@/lib/economy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The whole server-derived economy state for one user: tier, league, quests, medals, percentile,
 * wager, milestones, boosters, plus the two public numbers (rollover pot, biggest wins). Nothing here
 * is client-asserted — every field is computed from events the server itself recorded. */
export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") || "";
  const [pot, wins] = await Promise.all([rolloverPot(), biggestWins(10)]);
  if (!user) return NextResponse.json({ rollover: pot, biggestWins: wins });

  // A wager settles itself against the real streak every time the user is seen.
  await resolveWager(user).catch(() => {});
  const [earned, total, streak, league, beatPct, daily, weekly, wager, boosters, fore, milestone] = await Promise.all([
    lifetimeEarned(user), pointsTotal(user), computeStreak(user), weeklyLeague(user), percentileToday(user),
    dailyQuests(user), weeklyBoard(user), getWager(user), boosterState(user), foresight(user), checkMilestone(user),
  ]);
  const knockouts = await knockoutBoard(user).catch(() => null);

  return NextResponse.json({
    points: total,
    lifetimeEarned: earned,
    tier: tierFor(earned),
    tiersAll: TIERS,
    streak: streak.streak,
    freezes: streak.freezes,
    league,
    percentileToday: beatPct,
    medalToday: medalFor(beatPct),
    quests: daily,
    weeklyBoard: weekly,
    wager: wager ? { status: wager.status, startDay: Number(wager.start_day), stake: Number(wager.stake), payout: Number(wager.payout), targetDays: Number(wager.target_days) } : null,
    wagerTerms: WAGER,
    milestones: MILESTONES,
    milestoneReached: milestone,   // non-null exactly once, the first time it's banked
    boosters,
    foresight: fore,
    rollover: pot,
    biggestWins: wins,
    knockouts,
  });
}

/** Economy mutations. All token-guarded: only the user themselves can spend their own points. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const userId: string = b.userId || "";
    if (!userId) return NextResponse.json({ error: "missing user" }, { status: 400 });
    if (!(await tokenOk(userId, b.token || ""))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    switch (b.action) {
      case "open_wager": {
        const r = await openWager(userId);
        return NextResponse.json({ ...r, points: await pointsTotal(userId) }, { status: r.ok ? 200 : 400 });
      }
      case "earn_back": {
        const r = await earnBack(userId);
        return NextResponse.json({ ...r, points: await pointsTotal(userId) }, { status: r.ok ? 200 : 400 });
      }
      case "use_move": {
        const r = await useMove(userId, String(b.ref || "move"));
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }
      case "use_mystery": {
        const r = await useMystery(userId);
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }
      case "enter_knockouts": {
        const r = await enterKnockouts(userId);
        return NextResponse.json(r, { status: r.ok ? 200 : 400 });
      }
      /** T1/S1 — the 12% Stamp. Captured server-side at the moment of the lock: the room's consensus on
       * YOUR side, anchored to the TxLINE odds message that existed at that instant (MessageId + asOf).
       * The percentage is what the crowd gave you; the MessageId is what makes it checkable later. */
      case "stamp": {
        const market = String(b.market || "");
        const side = String(b.side || "");
        const calledAt = Math.max(0, Math.min(100, Math.round(Number(b.calledAt) || 0)));
        if (!market || !side) return NextResponse.json({ error: "missing market/side" }, { status: 400 });
        let messageId: string | null = null, asOf: number | null = null;
        const fixtureId = Number(b.fixtureId) || 0;
        if (fixtureId) {
          try {
            const { txline } = await import("@/lib/txline");
            const snap: any = await txline().oddsSnapshot(fixtureId);
            const row = Array.isArray(snap) ? snap[0] : snap;
            messageId = String(row?.MessageId ?? row?.messageId ?? "") || null;
            asOf = Number(row?.Ts ?? row?.ts) || Date.now();
          } catch { asOf = Date.now(); }
        }
        await saveStamp(userId, market, side, calledAt, messageId, asOf);
        return NextResponse.json({ ok: true, calledAt, messageId, asOf });
      }
      default:
        return NextResponse.json({ error: "bad action" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
