import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/serverConfig";
import { db } from "@/lib/db";
import { pushUser } from "@/lib/push";
import { utcDay } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** T5 — the morning slate push. One a day: the push ledger's unique tag means running this twice sends
 * nothing twice, so a cron that fires late or fires again is harmless. Class B, so the morning beat
 * competes for the day's four rather than sitting outside the budget.
 *
 * Triggered by a daily Vercel cron, which issues a GET — so GET and POST both run it, exactly like the
 * keeper. Without a scheduled trigger this whole feature was built but never fired. */
export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }

async function run(req: NextRequest) {
  if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const day = utcDay();
  const recap = await fetch(new URL("/api/recap", req.nextUrl.origin)).then((r) => r.json()).catch(() => null);
  const subs = await db()`SELECT DISTINCT user_id FROM push_subs`;

  const body = recap?.biggestWin
    ? `Yesterday's biggest call paid ${recap.biggestWin.payout.toFixed(2)}. Today's free call is up.`
    : "Today's free call is up. One tap, no sign-up.";

  let sent = 0;
  for (const r of subs as any[]) {
    sent += await pushUser(r.user_id, { title: recap?.dayLabel || "A new day at the Cup", body, url: "/", tag: `morning:${day}` }, "global", "B");
  }
  return NextResponse.json({ sent, recipients: (subs as any[]).length, day });
}
