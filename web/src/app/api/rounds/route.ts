import { NextRequest, NextResponse } from "next/server";
import { openFreeze, openBlackout, submitCall, getActiveRound, getLastSettled, getRound, maybeAutoFreeze } from "@/lib/rounds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Frozen Window a fan should see for a fixture: the active round (open/locked/sweating) if one is
 * running, plus the most-recently-settled round for a few seconds so the reveal lingers. */
export async function GET(req: NextRequest) {
  const fixture = Number(req.nextUrl.searchParams.get("fixture") || 0);
  const squad = req.nextUrl.searchParams.get("squad") || null;
  if (!fixture) return NextResponse.json({ active: null, settled: null });
  // getActiveRound may auto-settle a round it finds past its deadline — in that case it's returned but
  // its state is "settled", so surface it as the reveal, not an active takeover.
  let active = await getActiveRound(fixture, squad);
  if (active && active.state === "settled") return NextResponse.json({ active: null, settled: active });
  // Real-time: no round running → check the live feed; a goal that just landed auto-opens a Freeze
  // (throttled inside). This is what makes the window fire off the real match, not only a button.
  if (!active) active = await maybeAutoFreeze(fixture, squad);
  const settled = active ? null : await getLastSettled(fixture);
  return NextResponse.json({ active, settled });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    switch (b.action) {
      case "open": {
        // Trigger a round. During a live match the feed detector opens these automatically; a fan can
        // also replay a real moment. One active round per (fixture, squad) at a time — no spam.
        const fixtureId = Number(b.fixtureId) || 0;
        if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });
        const squad = b.squadCode || null;
        const existing = await getActiveRound(fixtureId, squad);
        if (existing) return NextResponse.json({ round: existing });
        const round = b.kind === "blackout"
          ? await openBlackout(fixtureId, squad, b.note || "")
          : await openFreeze(fixtureId, squad, b.underReview !== false, b.note || "");
        return NextResponse.json({ round });
      }
      case "call": {
        const r = await submitCall(String(b.roundId), String(b.userId || ""), String(b.name || ""), String(b.token || ""), String(b.side || ""));
        if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "unauthorized" ? 401 : r.reason === "locked" ? 409 : 400 });
        return NextResponse.json({ round: await getRound(String(b.roundId)) });
      }
      default: return NextResponse.json({ error: "bad action" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
