import { NextRequest, NextResponse } from "next/server";
import { adminOk, secretEq } from "@/lib/serverConfig";
import { matchResult } from "@/lib/matchResult";
import { gradePicks } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Grade the daily free call once a match is over.
 *
 * The free pick is one fixed question — "Goal before half-time?" (GafferApp `freePick`) — so a fixture has a
 * single YES/NO truth: did either side score inside the first half. We read that from TxLINE's signed feed
 * (the same finalised event stream that grades the Ear), never from a client, and hand it to `gradePicks`,
 * which awards the +25 `pick_win` to correct callers and consumes an armed Double-Down. Idempotent: the
 * `graded` flag and unique grant ref mean re-poking is harmless, so the worker can call it on every finish.
 *
 * Gated like the keeper: an operator/cron via `adminOk`, or the deployed agent host via `EAR_COMMIT_SECRET`.
 * It only awards points (never moves SOL), but it still writes the ledger, so it is not left open. */
async function run(req: NextRequest) {
  const agentOk = secretEq(req.headers.get("x-ear-key") || "", process.env.EAR_COMMIT_SECRET || "");
  if (!agentOk && !adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });

  const result = await matchResult(fixtureId);
  if (result.error) return NextResponse.json({ fixtureId, graded: 0, finished: false, error: result.error }, { status: 502 });
  // Only grade once the feed has finalised — otherwise "no goal before HT yet" would wrongly fail a pick
  // that a second-half-so-far match could still make true (the first half may not even be over).
  if (!result.finished) return NextResponse.json({ fixtureId, graded: 0, finished: false });

  const goalBeforeHalfTime = result.goals.some((g) => g.minute != null && g.minute < 45);
  const graded = await gradePicks(fixtureId, goalBeforeHalfTime);
  return NextResponse.json({ fixtureId, finished: true, yesWon: goalBeforeHalfTime, graded });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
