import { NextRequest, NextResponse } from "next/server";
import { txline } from "@/lib/txline";
import { tokenOk } from "@/lib/points";
import { db } from "@/lib/db";
import { utcDay } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Q8 — MYSTERY MATCH.
 *
 * A finished match, replayed anonymously from its real tick stream as a three-minute drama run. The
 * teams are stripped to "the home side" and "the away side", so the fun is reading the game rather than
 * remembering the result — fans only share win-probability charts *after* a match, when the moments that
 * changed it are fun to pinpoint. Every beat below is a real event that really happened at that minute;
 * nothing is generated.
 *
 * The breakpoints are the honest part: a call is asked at the minute BEFORE a real goal, so the fan is
 * guessing at exactly the moment the market did. The answer is read from the event that follows.
 */

const ACTION_WORD: Record<string, string> = {
  goal: "GOAL",
  attack_possession: "they're pushing",
  high_danger_possession: "a chance opens up",
  free_kick: "free kick",
  substitution: "a change is made",
  kickoff: "kick-off",
  standby: "the feed goes quiet",
  safe_possession: "they keep it",
  possession: "knocking it around",
  clock_adjustment: "the clock stops",
  game_finalised: "full time",
};

type Beat = { minute: number; text: string; big: boolean };
type Breakpoint = { atBeat: number; minute: number; question: string; answer: "yes" | "no" };

const minuteOf = (e: any) => (typeof e?.Clock?.Seconds === "number" && e.Clock.Seconds > 0 ? Math.floor(e.Clock.Seconds / 60) : 0);

/** Build the anonymised run from the real stream. */
function buildRun(events: any[]) {
  const ordered = [...events].sort((a, b) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));

  // Goals, by the minute they landed. The feed repeats a goal event (confirmations, stat re-sends), so
  // the same minute is the same goal — counting raw `goal` actions would claim fifteen in a 1–4 match.
  const goalMinutes = [...new Set(
    ordered.filter((e) => e.Action === "goal").map(minuteOf).filter((m) => m > 0),
  )].sort((a, b) => a - b);

  // Keep only events worth a beat, then thin them to a watchable run.
  const notable = ordered.filter((e) => ["goal", "high_danger_possession", "attack_possession", "free_kick", "substitution", "kickoff", "standby", "game_finalised"].includes(e.Action));
  const beats: Beat[] = [];
  let lastMinute = -1;
  for (const e of notable) {
    const m = minuteOf(e);
    const big = e.Action === "goal";
    if (!big && m === lastMinute) continue;              // one beat a minute, unless it's a goal
    beats.push({ minute: m, text: ACTION_WORD[e.Action] ?? e.Action, big });
    lastMinute = m;
    if (beats.length >= 40) break;                        // a three-minute run, not a full replay
  }

  // A question is asked just before a real goal — the fan guesses exactly where the market did. Each
  // goal gets its OWN beat (the latest quiet beat inside the five minutes before it), and a beat is
  // never used twice: one question per stopping point.
  const used = new Set<number>();
  const goalSoonAfter = (m: number) => goalMinutes.some((g) => g > m && g <= m + 5);
  const breaks: Breakpoint[] = [];

  for (const g of goalMinutes) {
    if (breaks.length >= 3) break;
    let at = -1;
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.big || used.has(i)) continue;
      if (b.minute < g && b.minute >= g - 5) at = i;      // take the LATEST such beat
    }
    if (at >= 0) { used.add(at); breaks.push({ atBeat: at, minute: beats[at].minute, question: "Goal in the next five minutes?", answer: "yes" }); }
  }

  // Quiet stretches, so the honest answer is not always "yes".
  for (const [i, b] of beats.entries()) {
    if (breaks.length >= 5) break;
    if (b.big || used.has(i)) continue;
    if (goalSoonAfter(b.minute)) continue;
    if (breaks.some((x) => Math.abs(x.minute - b.minute) < 8)) continue;  // don't cluster the questions
    used.add(i);
    breaks.push({ atBeat: i, minute: b.minute, question: "Goal in the next five minutes?", answer: "no" });
  }
  breaks.sort((a, b) => a.atBeat - b.atBeat);

  const finalHome = Number(ordered[ordered.length - 1]?.Stats?.["1"] ?? 0);
  const finalAway = Number(ordered[ordered.length - 1]?.Stats?.["2"] ?? 0);
  return { beats, breaks, finalHome, finalAway, goals: goalMinutes.length };
}

/** GET — an anonymised run for a finished fixture. The teams are never named. */
export async function GET(req: NextRequest) {
  const fixtureId = Number(req.nextUrl.searchParams.get("fixture") || 0);
  if (!fixtureId) return NextResponse.json({ error: "no fixture" }, { status: 400 });
  try {
    const events = await txline().historicalEvents(fixtureId);
    if (!events.length) return NextResponse.json({ error: "That match has no replay yet." }, { status: 404 });
    const finished = events.some((e: any) => e.Action === "game_finalised");
    if (!finished) return NextResponse.json({ error: "That match isn't finished." }, { status: 400 });

    const run = buildRun(events);
    if (run.breaks.length === 0) return NextResponse.json({ error: "Nothing worth calling in that one." }, { status: 400 });

    // The answers never leave the server. The client is sent only where to stop and what to ask.
    return NextResponse.json({
      fixtureId,
      beats: run.beats,
      breaks: run.breaks.map((b) => ({ atBeat: b.atBeat, minute: b.minute, question: b.question })),
      totalGoals: run.goals,
    });
  } catch {
    return NextResponse.json({ error: "The vault is catching its breath." }, { status: 500 });
  }
}

/** POST — grade a completed run. The calls are checked against the real stream, server-side, so a
 * client cannot mark its own homework. Points are granted once per fixture per user. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const userId = String(b.userId || "");
    const fixtureId = Number(b.fixtureId) || 0;
    const calls: { atBeat: number; side: "yes" | "no" }[] = Array.isArray(b.calls) ? b.calls : [];
    if (!userId || !fixtureId) return NextResponse.json({ error: "missing user/fixture" }, { status: 400 });
    if (!(await tokenOk(userId, String(b.token || "")))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const events = await txline().historicalEvents(fixtureId);
    const run = buildRun(events);
    const answers = new Map(run.breaks.map((x) => [x.atBeat, x.answer]));

    let right = 0;
    for (const c of calls) if (answers.get(Number(c.atBeat)) === c.side) right++;
    const total = run.breaks.length;

    // 5 points a correct read, banked once per fixture. Idempotent by ref.
    const amount = right * 5;
    if (amount > 0) {
      await db()`INSERT INTO points_events (user_id, kind, amount, ref, ts)
        VALUES (${userId}, 'mystery_win', ${amount}, ${`mystery:${fixtureId}`}, ${Date.now()})
        ON CONFLICT (user_id, kind, ref) DO NOTHING`;
    }
    await db()`INSERT INTO activity_days (user_id, day) VALUES (${userId}, ${utcDay()}) ON CONFLICT DO NOTHING`;

    // Only now do we say who it was. "No names until the end" has to mean the end names them.
    const nm = await db()`SELECT home, away FROM fixture_names WHERE fixture_id = ${fixtureId}`;
    const names = (nm as any[])[0];

    return NextResponse.json({
      right, total, points: amount,
      // Only now are the answers, the real scoreline and the teams revealed.
      answers: run.breaks.map((x) => ({ atBeat: x.atBeat, answer: x.answer })),
      finalHome: run.finalHome, finalAway: run.finalAway,
      home: names?.home ?? null, away: names?.away ?? null,
    });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
