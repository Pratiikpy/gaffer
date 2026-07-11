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
import { cached } from "./cache";

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
  roomTally: Record<string, number>;       // the real room, per option (same as tally, all options keyed)
  presence: number;                        // real people who have called it in this window — no padding
  calls: { userId: string; name: string; side: string; correct: boolean | null }[];
};

const rid = () => "r" + crypto.randomBytes(8).toString("hex");

/** The room around a round: the REAL people who called it, split by option. No fabricated crowd — the app
 * shows the true count, and when it's small the UI says so honestly rather than padding it with a fake
 * "84 in the window". Every option is present as a key (0 if nobody took it) so the split renders cleanly. */
function roomOf(r: any, _now: number, realTally: Record<string, number>): { presence: number; roomTally: Record<string, number> } {
  const roomTally: Record<string, number> = {};
  for (const o of (r.options as string[] | undefined) || []) roomTally[o] = realTally[o] || 0;
  const presence = Object.values(roomTally).reduce((a, b) => a + b, 0);
  return { presence, roomTally };
}

/** Total goals on the board right now (Stats keys 1 + 2). Cached briefly so opening/settling a round
 * doesn't pay the full historical-stream fetch every time.
 *
 * Most events carry no `Stats` block at all (status rows, clock ticks, disconnects), so the score must be
 * read off the newest event that actually has one — reading the *last* event returns 0–0 whenever the feed
 * ends on a statless row, which then settles a Frozen Window `NO GOAL` and a Freeze `OVERTURNED` on a
 * match that was 2–1, paying the wrong callers. This is the same walk-back `live.ts` does for exactly this
 * reason; the two must not diverge. `null` (feed error, or genuinely no stats yet) is returned as such so
 * the caller can refuse to settle rather than grade a real match as goalless. */
async function currentGoals(fixtureId: number): Promise<{ total: number; g1: number; g2: number } | null> {
  // Single-flighted: a whole squad settling the same round must not each fetch the stream.
  return cached(`goals:${fixtureId}`, { ttlMs: 20_000, swrMs: 60_000, staleMs: 120_000 }, async () => {
    const evs = await txline().historicalEvents(fixtureId);
    const bySeq = [...evs].sort((a: any, b: any) => Number(a.Seq ?? a.seq ?? 0) - Number(b.Seq ?? b.seq ?? 0));
    const withStats = [...bySeq].reverse().find((e: any) => e?.Stats && e.Stats["1"] != null);
    if (!withStats) return null;
    const g1 = Number(withStats.Stats["1"] ?? 0), g2 = Number(withStats.Stats["2"] ?? 0);
    return { total: g1 + g2, g1, g2 };
  }).catch(() => null);
}

/** The crowd's belief for the leading side, from the live consensus 1X2 line — the sweat strip's number.
 * Real when a match is live; null when the market is quiet (finished/no odds) — never fabricated. */
async function sweatPct(fixtureId: number): Promise<number | null> {
  return cached(`sweat:${fixtureId}`, { ttlMs: 5_000, swrMs: 30_000, staleMs: 60_000 }, () => readSweatPct(fixtureId)).catch(() => null);
}
async function readSweatPct(fixtureId: number): Promise<number | null> {
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
  const goals = await currentGoals(fixtureId);
  const total = goals?.total ?? 0, g1 = goals?.g1 ?? 0;
  const seed = await sweatPct(fixtureId);
  const baseline = underReview ? Math.max(0, total - 1) : total;
  const id = rid();
  const now = Date.now();
  await db()`INSERT INTO rounds (id, fixture_id, squad_code, kind, question, options, opened_at, locks_at, settles_at, baseline, state, sweat, note)
    VALUES (${id}, ${fixtureId}, ${squadCode}, 'freeze', ${"GOAL UNDER REVIEW — does it stand?"}, ${JSON.stringify(["STANDS", "OVERTURNED"])}::jsonb,
            ${now}, ${now + LOCK_MS}, ${now + FREEZE_MS}, ${baseline}, 'open',
            ${JSON.stringify(seed != null ? [{ t: now, pct: seed }] : [])}::jsonb, ${note || (g1 > baseline ? "Home have it in the net." : "It's on the board.")})`;
  // The synchronized ping: everyone in the squad gets buzzed the instant the window opens.
  if (squadCode) await pushSquad(squadCode, { title: "The Frozen Window is live", body: "Goal under review — 20s to call it. Does it stand?", url: "/", tag: `freeze:${id}` }, undefined, `fixture:${fixtureId}`, "B");
  return (await getRound(id))!;
}

/** Open a BLACKOUT round — the market just went quiet. Baseline is the per-team goal count at open. */
export async function openBlackout(fixtureId: number, squadCode: string | null, note = ""): Promise<RoundView> {
  const goals = await currentGoals(fixtureId);
  const g1 = goals?.g1 ?? 0, g2 = goals?.g2 ?? 0;
  const id = rid();
  const now = Date.now();
  // baseline packs both teams: g1*100 + g2 (each < 100 for a match) so settle can diff each side.
  await db()`INSERT INTO rounds (id, fixture_id, squad_code, kind, question, options, opened_at, locks_at, settles_at, baseline, state, sweat, note)
    VALUES (${id}, ${fixtureId}, ${squadCode}, 'blackout', ${"…the market went quiet. Call it."}, ${JSON.stringify(["HOME GOAL", "AWAY GOAL", "NO GOAL"])}::jsonb,
            ${now}, ${now + LOCK_MS}, ${now + BLACKOUT_MS}, ${g1 * 100 + g2}, 'open', '[]'::jsonb, ${note || "Ten seconds — what happens next?"})`;
  if (squadCode) await pushSquad(squadCode, { title: "… Blackout", body: "The market just went quiet. Call what happens next.", url: "/", tag: `blackout:${id}` }, undefined, `fixture:${fixtureId}`, "B");
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
  // If the score can't be read right now (feed error, or no stats event yet), do NOT grade — that would
  // settle the whole room off a phantom 0–0. Leave the round open; the next poll past `settles_at` retries.
  const goals = await currentGoals(Number(r.fixture_id));
  if (!goals) return getRound(roundId);
  const { total, g1, g2 } = goals;
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
  let right = 0;
  for (const c of calls as any[]) {
    const correct = c.side === outcome;
    await db()`UPDATE round_calls SET correct = ${correct} WHERE round_id = ${roundId} AND user_id = ${c.user_id}`;
    if (correct) { right++; await grantFrozenWin(c.user_id, roundId); }
  }

  // Q2 — name the moment the way the squad will tell it later, and pin it to the wall. Built from what
  // actually happened (the minute, the kind of window, whether the room read it), never a generic line.
  if (r.squad_code) {
    try {
      const { nameMoment, pinLore } = await import("./squadPlus");
      const state = await import("./live").then((m) => m.liveState(Number(r.fixture_id))).catch(() => null);
      const minute = state?.clockSeconds != null && state.clockSeconds > 0 ? Math.floor(state.clockSeconds / 60) : null;
      const roomRight = calls.length ? right > calls.length / 2 : null;
      const { title, detail } = nameMoment({ kind: r.kind, minute, roomRight, note: lore });
      await pinLore(r.squad_code, roundId, title, detail, minute);

      // Q4 — the reveal lands on every member's screen at the same instant, paced, not a silent ticker.
      const { pushSquad } = await import("./push");
      await pushSquad(r.squad_code, { title, body: detail, url: "/", tag: `lore:${roundId}` }, undefined, `fixture:${r.fixture_id}`, "B").catch(() => {});
    } catch { /* lore and the buzz are decoration; a settle must never fail because of them */ }
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

/* ─────────────────────────── L2 · the Blackout silence detector ─────────────────────────────────── */

/** How long the market must stay silent before we call it a Blackout. The measured gaps in the feed
 * cluster at exactly the decisive moments — a book that stops quoting is a book that doesn't know. */
export const SILENCE_MS = 30_000;

/** Per-fixture watch: the last odds message we saw, and when it first appeared. The feed carries no
 * reliable wall-clock on each row, so silence is measured by the message SEQUENCE going still — the
 * one signal that can't be faked by a slow response or a clock skew. */
const oddsWatch = new Map<number, { messageId: string; since: number }>();
const blackoutCheck = new Map<string, number>();

/** Read the newest odds MessageId for a fixture, or null when the book is quoting nothing at all. */
async function latestOddsMessage(fixtureId: number): Promise<string | null> {
  // Single-flighted: every phone in the window asks for this at the same second.
  return cached(`oddsmsg:${fixtureId}`, { ttlMs: 3_000, swrMs: 20_000, staleMs: 30_000 }, async () => {
    try {
      const { txline } = await import("./txline");
      const rows: any[] = await txline().oddsSnapshot(fixtureId);
      if (!rows?.length) return null;
      const id = rows[0]?.MessageId ?? rows[0]?.messageId;
      return id ? String(id) : null;
    } catch { return null; }
  });
}

/** Pure silence bookkeeping, so the rule can be tested without a live feed:
 *  - no quote at all        → 0ms silent, and nothing to remember (absence ≠ silence)
 *  - a NEW message id       → the market just spoke; the clock restarts at 0
 *  - the SAME message id    → it has been still since we first saw that id
 * Returns the silence in ms plus the watch entry to store. */
export function computeSilence(
  prev: { messageId: string; since: number } | undefined,
  id: string | null,
  now: number,
): { silentMs: number; next: { messageId: string; since: number } | undefined } {
  if (!id) return { silentMs: 0, next: prev };
  if (!prev || prev.messageId !== id) return { silentMs: 0, next: { messageId: id, since: now } };
  return { silentMs: now - prev.since, next: prev };
}

/** How long this fixture's odds have been still, in ms. 0 when they're moving (or unknown). */
export async function oddsSilenceMs(fixtureId: number): Promise<number> {
  const id = await latestOddsMessage(fixtureId);
  const { silentMs, next } = computeSilence(oddsWatch.get(fixtureId), id, Date.now());
  if (next) oddsWatch.set(fixtureId, next);
  return silentMs;
}

/** Real-time auto-trigger: the market goes quiet for SILENCE_MS during a live match → open a Blackout.
 * Same guards as the Freeze: throttled, and never stacked on another round. */
export async function maybeAutoBlackout(fixtureId: number, squadCode: string | null): Promise<RoundView | null> {
  const key = `${fixtureId}:${squadCode ?? ""}`;
  if (Date.now() - (blackoutCheck.get(key) || 0) < 10_000) return null;
  blackoutCheck.set(key, Date.now());

  // The Blackout is a market that STOPS quoting mid-play. A match that hasn't kicked off is quoted too,
  // and those pre-match lines sit unchanged for minutes at a time — so `computeSilence` reads a perfectly
  // healthy pre-match book as a thirty-second blackout and opens a round on a game nobody is playing. It
  // did exactly that, twelve hours before Spain v Belgium. Silence only means anything while the clock
  // is running: no live match, no Blackout.
  const live = await import("./live").then((m) => m.liveState(fixtureId)).catch(() => null);
  if (!live?.running) return null;

  const silent = await oddsSilenceMs(fixtureId);
  if (silent < SILENCE_MS) return null;
  const recent = await db()`SELECT 1 FROM rounds WHERE fixture_id = ${fixtureId} AND opened_at > ${Date.now() - FREEZE_MS} LIMIT 1`;
  if (recent.length) return null;
  // Reset the watch so one silence opens exactly one Blackout.
  oddsWatch.delete(fixtureId);
  return openBlackout(fixtureId, squadCode, "The market has stopped quoting. Nobody knows what just happened.");
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
