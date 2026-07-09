import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { utcDay } from "@/lib/points";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** T5 — "Day N at the Cup".
 *
 * Superbru ships one of these every single day of a tournament to 2.87M players; it is the cheapest
 * retention machine in the category. Every number here is already in our ledgers — the biggest payout,
 * the boldest call that landed, how many people played, what the room got right. Nothing is invented, and
 * a day with nothing to say says so rather than padding itself with a fabricated highlight.
 */

const TOURNAMENT_START_ISO = "2026-07-01";
const startDay = Math.floor(Date.parse(TOURNAMENT_START_ISO + "T00:00:00Z") / 86_400_000);

export type Recap = {
  day: number; dayLabel: string; date: string;
  players: number;
  calls: number;
  biggestWin: { name: string; question: string; stake: number; payout: number } | null;
  boldestCall: { name: string; question: string; calledAt: number } | null;
  roomAccuracy: number | null;      // share of graded free calls that landed
  poolsSettled: number;
  empty: boolean;                   // a quiet day is allowed to be quiet
};

export async function GET() {
  const recap = await cached("recap:today", { ttlMs: 60_000, swrMs: 5 * 60_000 }, build);
  return NextResponse.json(recap);
}

async function build(): Promise<Recap> {
  const day = utcDay();
  const since = day * 86_400_000, until = since + 86_400_000;
  const n = day - startDay + 1;

  const [playersRow, callsRow, winRow, boldRow, gradedRow, settledRow] = await Promise.all([
    db()`SELECT COUNT(DISTINCT user_id)::int AS n FROM points_events WHERE ts >= ${since} AND ts < ${until}`,
    db()`SELECT COUNT(*)::int AS n FROM picks WHERE ts >= ${since} AND ts < ${until}`,
    db()`SELECT name, question, stake_lamports, payout_lamports FROM wins
         WHERE ts >= ${since} AND ts < ${until} ORDER BY payout_lamports DESC LIMIT 1`,
    db()`SELECT name, question, called_at FROM wins
         WHERE ts >= ${since} AND ts < ${until} AND called_at IS NOT NULL ORDER BY called_at ASC LIMIT 1`,
    db()`SELECT COUNT(*) FILTER (WHERE correct)::int AS right, COUNT(*)::int AS total
         FROM picks WHERE graded = TRUE AND ts >= ${since} AND ts < ${until}`,
    db()`SELECT COUNT(*)::int AS n FROM settles WHERE ts >= ${since} AND ts < ${until}`,
  ]);

  const players = Number((playersRow as any[])[0]?.n ?? 0);
  const calls = Number((callsRow as any[])[0]?.n ?? 0);
  const w = (winRow as any[])[0];
  const b = (boldRow as any[])[0];
  const g = (gradedRow as any[])[0];
  const total = Number(g?.total ?? 0);

  return {
    day: n,
    dayLabel: n > 0 ? `Day ${n} at the Cup` : "Before the Cup",
    date: new Date(since).toISOString().slice(0, 10),
    players,
    calls,
    biggestWin: w ? { name: w.name || "A caller", question: w.question || "", stake: Number(w.stake_lamports) / 1e9, payout: Number(w.payout_lamports) / 1e9 } : null,
    boldestCall: b ? { name: b.name || "A caller", question: b.question || "", calledAt: Number(b.called_at) } : null,
    // Only report accuracy once enough calls were graded for the number to mean anything.
    roomAccuracy: total >= 5 ? Math.round((Number(g.right) / total) * 100) : null,
    poolsSettled: Number((settledRow as any[])[0]?.n ?? 0),
    empty: players === 0 && calls === 0,
  };
}
