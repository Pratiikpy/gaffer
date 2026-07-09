import { NextRequest, NextResponse } from "next/server";
import { liveState, HT_BEAT_MS } from "@/lib/live";
import { oddsSilenceMs, SILENCE_MS } from "@/lib/rounds";
import { tokenOk, todayPick, switchTodayPick } from "@/lib/points";
import { useMove } from "@/lib/economy";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which squads have already been buzzed for this fixture's halftime — the beat fires exactly once. */
const htPushed = new Set<string>();

/** L5/L7 — the live pulse for a fixture: clock, halftime, second half, and how long the market has been
 * silent (which is what arms the Blackout). Everything is read off the real feed; an unknown state is
 * reported as unknown rather than guessed. */
export async function GET(req: NextRequest) {
  const fixture = Number(req.nextUrl.searchParams.get("fixture") || 0);
  const user = req.nextUrl.searchParams.get("user") || "";
  const squad = req.nextUrl.searchParams.get("squad") || null;
  if (!fixture) return NextResponse.json({ error: "no fixture" }, { status: 400 });

  const [state, silentMs] = await Promise.all([liveState(fixture), oddsSilenceMs(fixture).catch(() => 0)]);
  const pick = user ? await todayPick(user).catch(() => null) : null;

  // L7 — one halftime push per squad per fixture, a minute into the break, and only to people who
  // actually have a call on this match (never buzz the uninvolved).
  if (state.atHalftime && squad) {
    const key = `${fixture}:${squad}`;
    if (!htPushed.has(key)) {
      htPushed.add(key);
      setTimeout(async () => {
        try {
          const { pushSquad } = await import("@/lib/push");
          await pushSquad(squad, {
            title: "Halftime",
            body: "45 minutes left. Stick with your call, or twist it.",
            url: "/", tag: `ht:${fixture}`,
          }, undefined, `fixture:${fixture}`, "B");
        } catch { /* push is best-effort; the beat still shows in-app */ }
      }, HT_BEAT_MS);
    }
  }

  return NextResponse.json({
    ...state,
    silentMs,
    silenceThresholdMs: SILENCE_MS,
    marketQuiet: silentMs >= SILENCE_MS,
    pick: pick && !pick.graded ? { fixtureId: pick.fixtureId, side: pick.side, quest: pick.quest } : null,
    canTwist: !!(pick && !pick.graded && state.atHalftime && pick.fixtureId === fixture),
  });
}

/** L8 — stick or twist. Exactly one move per matchday, taken at halftime, at a fixed stake: you may
 * flip today's free call to the other side. "Stick" costs nothing and is simply not calling this. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const userId = String(b.userId || "");
    if (!userId) return NextResponse.json({ error: "missing user" }, { status: 400 });
    if (!(await tokenOk(userId, String(b.token || "")))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const fixture = Number(b.fixtureId) || 0;
    const side = b.side === "no" ? "no" : "yes";
    const state = await liveState(fixture);
    if (!state.atHalftime) return NextResponse.json({ ok: false, reason: "The move is only open at halftime." }, { status: 400 });

    const pick = await todayPick(userId);
    if (!pick || pick.graded) return NextResponse.json({ ok: false, reason: "No open call to move." }, { status: 400 });
    if (pick.fixtureId !== fixture) return NextResponse.json({ ok: false, reason: "Your call isn't on this match." }, { status: 400 });
    // Check everything that can refuse the switch BEFORE burning the move — a fan must never lose
    // their one move of the day to a no-op.
    if (pick.side === side) return NextResponse.json({ ok: false, reason: "You're already on that side." }, { status: 400 });

    const move = await useMove(userId, `twist:${fixture}`);
    if (!move.ok) return NextResponse.json(move, { status: 400 });

    const sw = await switchTodayPick(userId, side);
    if (!sw.ok) return NextResponse.json(sw, { status: 400 });

    // Tell the squad — the twist is public, that's half the fun.
    if (b.squadCode) {
      await db()`INSERT INTO feed (squad_code, ts, user_id, name, kind, text)
        VALUES (${String(b.squadCode)}, ${Date.now()}, ${userId}, ${String(b.name || "A caller").slice(0, 40)}, 'system',
                ${`twisted at halftime — now on ${side.toUpperCase()}`})`.catch(() => {});
    }
    return NextResponse.json({ ok: true, side });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
