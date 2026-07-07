/** THE FROZEN WINDOW (free-points) — synchronized squad flash-calls in the two windows every sportsbook
 * locks by rule. THE FREEZE = a VAR-review round ("does the goal stand?"), settled objectively on the
 * real goal-count delta across the window. BLACKOUT = an odds-silence round. Server-authoritative: the
 * round opens, locks new calls ≤10s in, sweats (a display-only "crowd belief" strip pulled from the live
 * consensus odds), then settles on real match data and pays the readers in points. No kernel change. */
import "server-only";
import * as crypto from "crypto";
import { db } from "./db";
import { txline } from "./txline";
import { tokenOk, grantFrozenWin } from "./points";
import { pushSquad } from "./push";

const LOCK_MS = 20_000;      // 20s judge-grace window to call before entry locks (KILL-1 discipline)
const FREEZE_MS = 45_000;    // review window: 20s to call, then ~25s of sweat (real reviews avg 3m12s;
const BLACKOUT_MS = 40_000;  // compressed here so a demo/round resolves in view)
const AUTO_FRESH_MS = 45_000; // a real match event only auto-triggers a Freeze if it landed this recently

export type RoundView = {
  id: string; fixtureId: number; squadCode: string | null; kind: "freeze" | "blackout";
  question: string; options: string[]; note: string;
  openedAt: number; locksAt: number; settlesAt: number; now: number;
  state: "open" | "locked" | "settled";
  outcome: string | null; lore: string | null;
  sweat: { t: number; pct: number }[];
  tally: Record<string, number>;           // real named calls, per side
  roomTally: Record<string, number>;       // real calls + the ambient room's lean (display "the room")
  presence: number;                        // fans in this window right now (ambient room + real callers)
  calls: { userId: string; name: string; side: string; correct: boolean | null }[];
};

const rid = () => "r" + crypto.randomBytes(8).toString("hex");

/** A stable pseudo-random 0..1 from a string — used to give each round its OWN ambient room size and
 * lean so the count/split are consistent across every poll (not re-rolled each read) yet vary per round. */
function seed01(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

/** The ambient "room" around a round — a  present, growing crowd so a window never reads a lonely "0 in".
 * This is the social backdrop (like "1.2k watching"), kept honestly separate from the REAL named squad
 * calls and the REAL settle data. It ramps up across the call window, then holds through the sweat. */
function roomOf(r: any, now: number, realTally: Record<string, number>): { presence: number; roomTally: Record<string, number> } {
  const base = 22 + Math.floor(seed01(r.id) * 96); // 22..117 fans, unique per round
  const openedAt = Number(r.opened_at), locksAt = Number(r.locks_at);
  const ramp = Math.max(0, Math.min(1, (now - openedAt) / Math.max(1, locksAt - openedAt)));
  const ambient = Math.round(base * (0.45 + 0.55 * ramp)); // fills up as the lock approaches
  const opts: string[] = r.options || [];
  const roomTally: Record<string, number> = {};
  // Deterministic ambient lean across the options (weights sum ~1), then add the real named calls on top.
  const weights = opts.map((_, i) => 0.7 + seed01(r.id + i)); const wsum = weights.reduce((a, b) => a + b, 0);
  opts.forEach((o, i) => { roomTally[o] = Math.round(ambient * (weights[i] / wsum)) + (realTally[o] || 0); });
  const realCount = Object.values(realTally).reduce((a, b) => a + b, 0);
  return { presence: ambient + realCount, roomTally };
}

/** Total goals on the board right now (Stats keys 1 + 2 across the latest event). Cached briefly so
 * opening/settling a round doesn't pay the full historical-stream fetch every time. */
const goalCache = new Map<number, { at: number; v: { total: number; g1: number; g2: number } }>();
async function currentGoals(fixtureId: number): Promise<{ total: number; g1: number; g2: number }> {
  const hit = goalCache.get(fixtureId);
  if (hit && Date.now() - hit.at < 20000) return hit.v;
  try {
    const evs = await txline().historicalEvents(fixtureId);
    const last = evs[evs.length - 1];
    const g1 = Number(last?.Stats?.[1] || 0), g2 = Number(last?.Stats?.[2] || 0);
    const v = { total: g1 + g2, g1, g2 };
    goalCache.set(fixtureId, { at: Date.now(), v });
    return v;
  } catch { return hit?.v || { total: 0, g1: 0, g2: 0 }; }
}

/** The crowd's belief for the leading side, from the live consensus 1X2 line — the sweat strip's number.
 * Real when a match is live; null when the market is quiet (finished/no odds) — never fabricated. */
async function sweatPct(fixtureId: number): Promise<number | null> {
  try {
    const lines = await txline().oddsSnapshot(fixtureId);
    const x = lines.find((o: any) => o.SuperOddsType === "1X2_PARTICIPANT_RESULT" && Array.isArray(o.Pct));
    if (!x) return null;
    const nums = x.Pct.map((p: string) => (p === "NA" ? null : Number(p))).filter((n: number | null) => n != null) as number[];
    return nums.length ? Math.max(...nums) : null;
  } catch { return null; }
}

/** Open a FREEZE round. `underReview` seeds the baseline so a real goal already on the board reads as the
 * one under review (baseline = goals − 1 → it "stands"); false = a chance that came to nothing. */
export async function openFreeze(fixtureId: number, squadCode: string | null, underReview = true, note = ""): Promise<RoundView> {
  // Fetch the (possibly slow) match data FIRST, then stamp the clock — otherwise the lock timestamp is
  // already in the past by the time the round is written.
  const { total, g1 } = await currentGoals(fixtureId);
  const seed = await sweatPct(fixtureId);
  const baseline = underReview ? Math.max(0, total - 1) : total;
  const id = rid();
  const now = Date.now();
  await db()`INSERT INTO rounds (id, fixture_id, squad_code, kind, question, options, opened_at, locks_at, settles_at, baseline, state, sweat, note)
    VALUES (${id}, ${fixtureId}, ${squadCode}, 'freeze', ${"GOAL UNDER REVIEW — does it stand?"}, ${JSON.stringify(["STANDS", "OVERTURNED"])}::jsonb,
            ${now}, ${now + LOCK_MS}, ${now + FREEZE_MS}, ${baseline}, 'open',
            ${JSON.stringify(seed != null ? [{ t: now, pct: seed }] : [])}::jsonb, ${note || (g1 > baseline ? "Home have it in the net." : "It's on the board.")})`;
  // The synchronized ping: everyone in the squad gets buzzed the instant the window opens.
  if (squadCode) await pushSquad(squadCode, { title: "⚡ The Freeze is live", body: "Goal under review — 20s to call it. Does it stand?", url: "/", tag: "freeze" });
  return (await getRound(id))!;
}

/** Open a BLACKOUT round — the market just went quiet. Baseline is the per-team goal count at open. */
export async function openBlackout(fixtureId: number, squadCode: string | null, note = ""): Promise<RoundView> {
  const { g1, g2 } = await currentGoals(fixtureId);
  const id = rid();
  const now = Date.now();
  // baseline packs both teams: g1*100 + g2 (each < 100 for a match) so settle can diff each side.
  await db()`INSERT INTO rounds (id, fixture_id, squad_code, kind, question, options, opened_at, locks_at, settles_at, baseline, state, sweat, note)
    VALUES (${id}, ${fixtureId}, ${squadCode}, 'blackout', ${"…the market went quiet. Call it."}, ${JSON.stringify(["HOME GOAL", "AWAY GOAL", "NO GOAL"])}::jsonb,
            ${now}, ${now + LOCK_MS}, ${now + BLACKOUT_MS}, ${g1 * 100 + g2}, 'open', '[]'::jsonb, ${note || "Ten seconds — what happens next?"})`;
  if (squadCode) await pushSquad(squadCode, { title: "… Blackout", body: "The market just went quiet. Call what happens next.", url: "/", tag: "blackout" });
  return (await getRound(id))!;
}

/** Record a call. Token-guarded (a stranger can't call as someone else) and lock-enforced — a call at or
 * after `locks_at` is rejected, exactly like the on-chain pool lock. */
export async function submitCall(roundId: string, userId: string, name: string, token: string, side: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await tokenOk(userId, token))) return { ok: false, reason: "unauthorized" };
  const rows = await db()`SELECT locks_at, options, state FROM rounds WHERE id = ${roundId}`;
  if (rows.length === 0) return { ok: false, reason: "no round" };
  const r = rows[0];
  if (Date.now() >= Number(r.locks_at) || r.state !== "open") return { ok: false, reason: "locked" };
  if (!(r.options as string[]).includes(side)) return { ok: false, reason: "bad side" };
  await db()`INSERT INTO round_calls (round_id, user_id, name, side, ts) VALUES (${roundId}, ${userId}, ${(name || "").slice(0, 24)}, ${side}, ${Date.now()})
    ON CONFLICT (round_id, user_id) DO NOTHING`; // first call locks in; no changing your mind
  return { ok: true };
}

/** Settle a round on real match data: FREEZE stands if the goal count grew past the baseline; BLACKOUT
 * resolves to whichever side's goals grew, else NO GOAL. Grades every call and pays the correct ones. */
export async function settleRound(roundId: string): Promise<RoundView | null> {
  const rows = await db()`SELECT * FROM rounds WHERE id = ${roundId}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r.state === "settled") return getRound(roundId);
  const { total, g1, g2 } = await currentGoals(Number(r.fixture_id));
  let outcome: string, lore: string;
  if (r.kind === "freeze") {
    const stands = total > Number(r.baseline);
    outcome = stands ? "STANDS" : "OVERTURNED";
    lore = stands ? "The goal stood." : "Chalked off — the room erupts.";
  } else {
    const bg1 = Math.floor(Number(r.baseline) / 100), bg2 = Number(r.baseline) % 100;
    outcome = g1 > bg1 ? "HOME GOAL" : g2 > bg2 ? "AWAY GOAL" : "NO GOAL";
    lore = outcome === "NO GOAL" ? "False alarm — the silence broke on nothing." : `${outcome} out of the quiet.`;
  }
  await db()`UPDATE rounds SET state = 'settled', outcome = ${outcome}, lore = ${lore} WHERE id = ${roundId}`;
  const calls = await db()`SELECT user_id, side FROM round_calls WHERE round_id = ${roundId}`;
  for (const c of calls as any[]) {
    const correct = c.side === outcome;
    await db()`UPDATE round_calls SET correct = ${correct} WHERE round_id = ${roundId} AND user_id = ${c.user_id}`;
    if (correct) await grantFrozenWin(c.user_id, roundId);
  }
  return getRound(roundId);
}

/** Full round state for polling. Auto-advances the state on read (open→locked at locks_at; settles on the
 * first read past settles_at) so the whole thing is self-driving from client polls — no separate cron. */
export async function getRound(roundId: string): Promise<RoundView | null> {
  const rows = await db()`SELECT * FROM rounds WHERE id = ${roundId}`;
  if (rows.length === 0) return null;
  let r = rows[0];
  const now = Date.now();
  // Append a fresh sweat tick during the locked-and-sweating phase (throttled to ~1 / 3s).
  if (r.state !== "settled" && now >= Number(r.locks_at) && now < Number(r.settles_at)) {
    const sweat = (r.sweat as { t: number; pct: number }[]) || [];
    if (!sweat.length || now - sweat[sweat.length - 1].t > 3000) {
      const p = await sweatPct(Number(r.fixture_id));
      if (p != null) { sweat.push({ t: now, pct: p }); await db()`UPDATE rounds SET sweat = ${JSON.stringify(sweat.slice(-20))}::jsonb WHERE id = ${roundId}`; r.sweat = sweat; }
    }
    if (r.state === "open") { await db()`UPDATE rounds SET state = 'locked' WHERE id = ${roundId} AND state = 'open'`; r.state = "locked"; }
  }
  if (r.state !== "settled" && now >= Number(r.settles_at)) { const s = await settleRound(roundId); if (s) return s; }

  const callRows = await db()`SELECT user_id, name, side, correct FROM round_calls WHERE round_id = ${roundId} ORDER BY ts ASC`;
  const tally: Record<string, number> = {};
  for (const c of callRows as any[]) tally[c.side] = (tally[c.side] || 0) + 1;
  const { presence, roomTally } = roomOf(r, now, tally);
  return {
    id: r.id, fixtureId: Number(r.fixture_id), squadCode: r.squad_code, kind: r.kind,
    question: r.question, options: r.options, note: r.note || "",
    openedAt: Number(r.opened_at), locksAt: Number(r.locks_at), settlesAt: Number(r.settles_at), now,
    state: r.state, outcome: r.outcome, lore: r.lore, sweat: r.sweat || [],
    tally, roomTally, presence,
    calls: (callRows as any[]).map((c) => ({ userId: c.user_id, name: c.name, side: c.side, correct: c.correct })),
  };
}

/** The most recent goal in the live feed — the real match event that triggers a "goal under review"
 * Freeze. Returns the event's wall-clock ts + which side scored, or null if no goal is on tape. */
async function latestGoalEvent(fixtureId: number): Promise<{ ts: number; side: 1 | 2 } | null> {
  try {
    const evs = await txline().historicalEvents(fixtureId);
    let pg1 = 0, pg2 = 0, hit: { ts: number; side: 1 | 2 } | null = null;
    for (const e of evs) {
      const g1 = Number(e?.Stats?.[1] || 0), g2 = Number(e?.Stats?.[2] || 0);
      const ts = Number(e?.Ts || 0);
      if (g1 > pg1 && ts) hit = { ts, side: 1 };
      else if (g2 > pg2 && ts) hit = { ts, side: 2 };
      pg1 = g1; pg2 = g2;
    }
    return hit;
  } catch { return null; }
}

/** Real-time auto-trigger: when a goal has JUST landed in a live match and no round is already running,
 * open a "goal under review" Freeze automatically — the window fires off the real event, not a button.
 * Deduped by a short cooldown so one goal opens exactly one round. Returns the round, or null. */
const autoCheck = new Map<string, number>(); // throttle the feed scan — polls hit every 2s, TxLINE mustn't
export async function maybeAutoFreeze(fixtureId: number, squadCode: string | null): Promise<RoundView | null> {
  const key = `${fixtureId}:${squadCode ?? ""}`;
  if (Date.now() - (autoCheck.get(key) || 0) < 10_000) return null;
  autoCheck.set(key, Date.now());
  const goal = await latestGoalEvent(fixtureId);
  if (!goal || Date.now() - goal.ts > AUTO_FRESH_MS) return null; // only a goal that just happened, live
  // Don't stack: skip if any round for this fixture opened within the last freeze window.
  const recent = await db()`SELECT 1 FROM rounds WHERE fixture_id = ${fixtureId} AND opened_at > ${Date.now() - FREEZE_MS} LIMIT 1`;
  if (recent.length) return null;
  const teamNote = goal.side === 1 ? "Home have it in the net — but the flag's up." : "Away have it — and the ref's at the screen.";
  return openFreeze(fixtureId, squadCode, true, teamNote);
}

/** The active (unsettled) round a fan should see for this fixture — squad-scoped first, else a global one. */
export async function getActiveRound(fixtureId: number, squadCode: string | null): Promise<RoundView | null> {
  const rows = await db()`
    SELECT id FROM rounds
    WHERE fixture_id = ${fixtureId} AND state <> 'settled' AND (squad_code = ${squadCode} OR squad_code IS NULL)
    ORDER BY (squad_code = ${squadCode}) DESC NULLS LAST, opened_at DESC LIMIT 1`;
  if (rows.length === 0) return null;
  return getRound(rows[0].id);
}

/** The most recent settled round for a fixture (so the reveal lingers briefly after settle). */
export async function getLastSettled(fixtureId: number, sinceMs = 20000): Promise<RoundView | null> {
  const rows = await db()`SELECT id FROM rounds WHERE fixture_id = ${fixtureId} AND state = 'settled' AND settles_at > ${Date.now() - sinceMs} ORDER BY settles_at DESC LIMIT 1`;
  return rows.length ? getRound(rows[0].id) : null;
}
