import { NextRequest, NextResponse } from "next/server";
import {
  grantFreePick, grantStreakBonus, grantStakeVerified, grantWinVerified, grantShare,
  pointsTotal, touchActivityAndStreak, computeStreak, ensureUserToken, tokenOk,
} from "@/lib/points";
import { setMemberStreak } from "@/lib/squadStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a user's server-authoritative points + streak, and mint/return their per-user token on first
 * contact so the client can present it on every later grant (grants are token-guarded, KILL-2). */
export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") || "";
  if (!user) return NextResponse.json({ points: 0, streak: 0, freezes: 0, token: null });
  const [points, s, tk] = await Promise.all([pointsTotal(user), computeStreak(user), ensureUserToken(user)]);
  return NextResponse.json({ points, streak: s.streak, freezes: s.freezes, token: tk.token });
}

/** Grant points from a server-observed event. Every mutation requires the user's own token (so no one
 * can post grants for another id); money grants (stake/win) are additionally verified on-chain down to
 * the exact instruction. A client can never post a points TOTAL, a side it didn't earn, or a forged win. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const userId: string = b.userId || "";
    if (!userId) return NextResponse.json({ error: "missing user" }, { status: 400 });
    if (!(await tokenOk(userId, b.token || ""))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const squadCode: string | null = b.squadCode || null;
    let granted = false;

    switch (b.action) {
      case "free_pick": {
        await grantFreePick(userId, String(b.side || "yes"), Number(b.fixtureId) || 0, String(b.quest || ""), squadCode);
        const s = await touchActivityAndStreak(userId);   // record today + advance streak
        await grantStreakBonus(userId);                    // idempotent per day
        await setMemberStreak(userId, s.streak);           // reflect on the leaderboard
        const points = await pointsTotal(userId);
        return NextResponse.json({ points, streak: s.streak, freezes: s.freezes });
      }
      case "stake": granted = await grantStakeVerified(userId, b.sig, squadCode); break;
      case "win": granted = await grantWinVerified(userId, b.sig, squadCode); break;
      case "share": granted = await grantShare(userId); break;
      default: return NextResponse.json({ error: "bad action" }, { status: 400 });
    }
    const points = await pointsTotal(userId);
    return NextResponse.json({ points, granted });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
