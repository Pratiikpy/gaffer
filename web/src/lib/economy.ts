/** The economy layer (master-spec §5): status tiers, weekly leagues, quests, medals, percentile
 * feedback, the Streak Wager, milestones, the rollover pot, boosters, and the wins ledger.
 *
 * Everything here is SERVER-DERIVED. A tier, a quest tick, a medal or a percentile is computed from
 * events the server itself observed (the points ledger, graded picks, the activity ledger) — the client
 * never asserts progress, exactly as K3 demands. Spending points never lowers a tier: tiers read
 * LIFETIME EARNED (the sum of positive grants), which is monotone. */
import "server-only";
import { db } from "./db";
import { utcDay, computeStreak, pointsTotal } from "./points";

/* ─────────────────────────── Y3 · Status tiers (lifetime earned, never reduced) ─────────────────── */

export const TIERS = [
  { name: "Sunday League", min: 0 },
  { name: "Academy", min: 500 },
  { name: "First Team", min: 1_500 },
  { name: "Skipper", min: 3_500 },
  { name: "Gaffer", min: 8_000 },
] as const;

/** Sum of POSITIVE grants only — spending (a wager stake) can never demote you. */
export async function lifetimeEarned(userId: string): Promise<number> {
  if (!userId) return 0;
  const r = await db()`SELECT COALESCE(SUM(amount),0)::int AS n FROM points_events WHERE user_id = ${userId} AND amount > 0`;
  return Number(r[0]?.n ?? 0);
}

export function tierFor(earned: number) {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (earned >= TIERS[k].min) i = k;
  const next = TIERS[i + 1] ?? null;
  return {
    name: TIERS[i].name,
    index: i,
    next: next?.name ?? null,
    toNext: next ? Math.max(0, next.min - earned) : 0,
    // progress through the current band, for a bar
    pct: next ? Math.round(((earned - TIERS[i].min) / (next.min - TIERS[i].min)) * 100) : 100,
  };
}

/* ─────────────────────────── Y3 · Weekly leagues of 30 ──────────────────────────────────────────── */

/** Start of the current league week — MONDAY 00:00 UTC. (Epoch day 0 was a Thursday, hence the +3.)
 * Anchoring to a real weekday matters: an epoch-aligned week rolls over mid-week and silently empties
 * every league. Stage boundaries in a tournament fall on weeks, so the week IS the reset. */
export function weekStart(ms = Date.now()): number {
  const day = Math.floor(ms / 86_400_000);
  return (day - ((day + 3) % 7)) * 86_400_000;
}

/** This week's league: players bucketed into leagues of 30 by points earned since `weekStart`.
 * EVERY known player appears (0 weekly points ranks last) so a user always has a league to look at. */
export async function weeklyLeague(userId: string): Promise<{
  league: number; rank: number; size: number; weekStart: number;
  rows: { userId: string; points: number; rank: number; you: boolean }[];
}> {
  const since = weekStart();
  const all = await db()`
    SELECT u.user_id, COALESCE(p.pts, 0)::int AS pts
    FROM user_state u
    LEFT JOIN (
      SELECT user_id, SUM(amount)::int AS pts FROM points_events
      WHERE ts >= ${since} AND amount > 0 GROUP BY user_id
    ) p ON p.user_id = u.user_id
    ORDER BY pts DESC, u.user_id ASC`;
  const list = (all as any[]).map((r) => ({ userId: r.user_id as string, points: Number(r.pts) }));
  const idx = list.findIndex((r) => r.userId === userId);
  if (idx < 0) return { league: 1, rank: 0, size: 0, weekStart: since, rows: [] };
  const league = Math.floor(idx / 30);
  const slice = list.slice(league * 30, league * 30 + 30);
  return {
    league: league + 1,
    rank: idx - league * 30 + 1,
    size: slice.length,
    weekStart: since,
    rows: slice.map((r, i) => ({ userId: r.userId, points: r.points, rank: i + 1, you: r.userId === userId })),
  };
}

/* ─────────────────────────── Y7 · Percentile + medals ───────────────────────────────────────────── */

export type Medal = "gold" | "silver" | "bronze" | null;
/** Medal from a percentile-beaten figure. Deliberately coarse — we never print precision we can't back. */
export function medalFor(beatPct: number | null): Medal {
  if (beatPct == null) return null;
  if (beatPct >= 90) return "gold";
  if (beatPct >= 75) return "silver";
  if (beatPct >= 50) return "bronze";
  return null;
}

/** "Your call beat X% of players today." Null when the cohort is too small to be honest about. */
export async function percentileToday(userId: string): Promise<number | null> {
  const since = utcDay() * 86_400_000;
  const rows = await db()`
    SELECT user_id, COALESCE(SUM(amount),0)::int AS pts
    FROM points_events WHERE ts >= ${since} AND amount > 0 GROUP BY user_id`;
  const list = rows as any[];
  if (list.length < 5) return null; // too few players today to make a percentile mean anything
  const me = Number(list.find((r) => r.user_id === userId)?.pts ?? 0);
  if (!me) return null;
  const below = list.filter((r) => Number(r.pts) < me).length;
  return Math.round((below / list.length) * 100);
}

/* ─────────────────────────── T2 · Quests (server-verified) + weekly board ───────────────────────── */

/** A day's quest state is DERIVED from the ledger the server wrote — a client can't tick a quest. */
export async function dailyQuests(userId: string): Promise<{
  quests: { id: string; label: string; done: boolean }[]; done: number; total: number; medal: Medal;
}> {
  const day = utcDay(), since = day * 86_400_000;
  const g = await db()`SELECT DISTINCT kind FROM points_events WHERE user_id = ${userId} AND ts >= ${since}`;
  const kinds = new Set((g as any[]).map((r) => r.kind));
  const act = await db()`SELECT 1 FROM activity_days WHERE user_id = ${userId} AND day = ${day}`;
  const quests = [
    { id: "free_call", label: "Make today's free call", done: kinds.has("free_pick") },
    { id: "back_call", label: "Back a call with coins", done: kinds.has("stake") },
    { id: "streak", label: "Keep your streak alive", done: act.length > 0 },
  ];
  const done = quests.filter((q) => q.done).length;
  // Medal on the daily board: 3/3 gold, 2/3 silver, 1/3 bronze.
  const medal: Medal = done >= 3 ? "gold" : done === 2 ? "silver" : done === 1 ? "bronze" : null;
  return { quests, done, total: quests.length, medal };
}

/** The weekly board of 10, with ENDOWED PROGRESS: two arrive pre-completed (Nunes & Drèze: 34% vs 19%). */
export async function weeklyBoard(userId: string): Promise<{ items: { id: string; label: string; done: boolean; endowed?: boolean }[]; done: number; total: number }> {
  const since = weekStart();
  const g = await db()`SELECT kind, COUNT(*)::int AS n FROM points_events WHERE user_id = ${userId} AND ts >= ${since} GROUP BY kind`;
  const n = Object.fromEntries((g as any[]).map((r) => [r.kind, Number(r.n)])) as Record<string, number>;
  const days = await db()`SELECT COUNT(*)::int AS n FROM activity_days WHERE user_id = ${userId} AND day >= ${Math.floor(since / 86_400_000)}`;
  const activeDays = Number((days as any[])[0]?.n ?? 0);
  const items = [
    { id: "welcome", label: "Join the Cup", done: true, endowed: true },          // endowed
    { id: "first_look", label: "Open the app", done: true, endowed: true },        // endowed
    { id: "free_3", label: "Make 3 free calls", done: (n.free_pick ?? 0) >= 3 },
    { id: "stake_1", label: "Back a call with coins", done: (n.stake ?? 0) >= 1 },
    { id: "win_1", label: "Win a pool", done: (n.win ?? 0) >= 1 },
    { id: "hilo_3", label: "Call 3 Hi-Los right", done: (n.hilo_win ?? 0) >= 3 },
    { id: "frozen_1", label: "Read a Frozen Window right", done: (n.frozen_win ?? 0) >= 1 },
    { id: "squad", label: "Join or start a squad", done: (n.squad_join ?? 0) >= 1 },
    { id: "share", label: "Share a card", done: (n.share ?? 0) >= 1 },
    { id: "days_5", label: "Play 5 days this week", done: activeDays >= 5 },
  ];
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

/* ─────────────────────────── T3 · Streak Wager · milestones · Earn-Back ─────────────────────────── */

export const WAGER = { stake: 200, payout: 400, targetDays: 7 } as const;
export const MILESTONES = [3, 7, 14, 21, 33] as const;

/** Dark-Day Cover lives with the streak walk that consumes it (points.ts) — re-exported here so the
 * economy surface is one import for callers. */
export { DARK_DAYS, DARK_DAYS_ISO, isDarkDay } from "./points";

export async function getWager(userId: string) {
  const r = await db()`SELECT * FROM streak_wager WHERE user_id = ${userId}`;
  return (r as any[])[0] ?? null;
}

/** Open a Streak Wager: spend `stake` points now; keep the run alive `targetDays` matchdays → `payout`.
 * Duolingo's own A/B put the wager at +14% D7, their best-measured mechanic. */
export async function openWager(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const existing = await getWager(userId);
  if (existing && existing.status === "open") return { ok: false, reason: "You already have a wager running." };
  const total = await pointsTotal(userId);
  if (total < WAGER.stake) return { ok: false, reason: `You need ${WAGER.stake} points to place the wager.` };
  const now = Date.now();
  // The stake is a NEGATIVE ledger event — it lowers the spendable balance but never lifetime-earned.
  await db()`INSERT INTO points_events (user_id, kind, amount, ref, ts)
    VALUES (${userId}, 'wager_stake', ${-WAGER.stake}, ${"wager:" + utcDay()}, ${now})
    ON CONFLICT (user_id, kind, ref) DO NOTHING`;
  await db()`INSERT INTO streak_wager (user_id, start_day, target_days, stake, payout, status, ts)
    VALUES (${userId}, ${utcDay()}, ${WAGER.targetDays}, ${WAGER.stake}, ${WAGER.payout}, 'open', ${now})
    ON CONFLICT (user_id) DO UPDATE SET start_day = ${utcDay()}, status = 'open', ts = ${now}`;
  return { ok: true };
}

/** Settle an open wager against the SERVER-derived streak. Called on every activity touch. */
export async function resolveWager(userId: string): Promise<"open" | "won" | "lost" | "none"> {
  const w = await getWager(userId);
  if (!w || w.status !== "open") return w ? (w.status as any) : "none";
  const { streak } = await computeStreak(userId);
  const elapsed = utcDay() - Number(w.start_day);
  if (streak >= Number(w.target_days)) {
    await db()`INSERT INTO points_events (user_id, kind, amount, ref, ts)
      VALUES (${userId}, 'wager_win', ${Number(w.payout)}, ${"wagerwin:" + w.start_day}, ${Date.now()})
      ON CONFLICT (user_id, kind, ref) DO NOTHING`;
    await db()`UPDATE streak_wager SET status = 'won' WHERE user_id = ${userId}`;
    return "won";
  }
  // The run died before the target (streak reset to 0 with days still elapsed) → the stake is lost.
  if (streak === 0 && elapsed > 0) {
    await db()`UPDATE streak_wager SET status = 'lost' WHERE user_id = ${userId}`;
    return "lost";
  }
  return "open";
}

/** Milestones 3/7/14/21/33 — returns the milestone newly reached this call (so the UI mints its card once). */
export async function checkMilestone(userId: string): Promise<number | null> {
  const { streak } = await computeStreak(userId);
  const hit = MILESTONES.filter((m) => streak >= m).pop();
  if (!hit) return null;
  const rows = await db()`INSERT INTO milestones (user_id, days, ts) VALUES (${userId}, ${hit}, ${Date.now()})
    ON CONFLICT (user_id, days) DO NOTHING RETURNING days`;
  return rows.length ? hit : null; // non-null only the first time this milestone is banked
}

/** Earn-Back: a broken run can be repaired once, by paying points — the streak's activity gap is
 * backfilled for yesterday so the walk reconnects. Costs 100 points; never free, never automatic. */
export async function earnBack(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const { streak } = await computeStreak(userId);
  if (streak > 0) return { ok: false, reason: "Your run is already alive." };
  const total = await pointsTotal(userId);
  if (total < 100) return { ok: false, reason: "You need 100 points to repair your run." };
  const yesterday = utcDay() - 1;
  const prior = await db()`SELECT 1 FROM activity_days WHERE user_id = ${userId} AND day < ${yesterday} LIMIT 1`;
  if (!prior.length) return { ok: false, reason: "There's no run to repair yet." };
  await db()`INSERT INTO points_events (user_id, kind, amount, ref, ts)
    VALUES (${userId}, 'earn_back', -100, ${"earnback:" + yesterday}, ${Date.now()})
    ON CONFLICT (user_id, kind, ref) DO NOTHING`;
  await db()`INSERT INTO activity_days (user_id, day) VALUES (${userId}, ${yesterday}) ON CONFLICT DO NOTHING`;
  return { ok: true };
}

/* ─────────────────────────── T4 · Rollover headline pot (a real, provable number) ───────────────── */

/** Claim a market's dust exactly once, ever. Returns true only if THIS call won the claim — so a
 * repeated sweep can never inflate the pot. The pot has to be a real number or it is worth nothing. */
export async function markSwept(market: string, lamports: number): Promise<boolean> {
  const rows = await db()`INSERT INTO swept_markets (market, lamports, ts)
    VALUES (${market}, ${Math.round(lamports)}, ${Date.now()})
    ON CONFLICT (market) DO NOTHING RETURNING market`;
  return rows.length > 0;
}

/** Record lamports left behind by a settled pool (rounding dust nobody is owed). Accumulates per day. */
export async function addRollover(lamports: number, sources = 1) {
  if (!Number.isFinite(lamports) || lamports <= 0) return;
  const day = utcDay();
  await db()`INSERT INTO rollover (day, lamports, sources, ts) VALUES (${day}, ${Math.round(lamports)}, ${sources}, ${Date.now()})
    ON CONFLICT (day) DO UPDATE SET lamports = rollover.lamports + ${Math.round(lamports)}, sources = rollover.sources + ${sources}`;
}

/** Everything carried in so far — it only ever grows, and it's the sum of real on-chain remainders. */
export async function rolloverPot(): Promise<{ lamports: number; sol: number; sources: number }> {
  const r = await db()`SELECT COALESCE(SUM(lamports),0)::bigint AS l, COALESCE(SUM(sources),0)::int AS s FROM rollover WHERE day < ${utcDay() + 1}`;
  const lamports = Number((r as any[])[0]?.l ?? 0);
  return { lamports, sol: lamports / 1e9, sources: Number((r as any[])[0]?.s ?? 0) };
}

/* ─────────────────────────── T7 / L8 · Boosters and the one mid-match move ──────────────────────── */

/** The Mystery booster is visible from day one and only REVEALS at the knockout stage. What it turns out
 * to be — Double Down: your next correct call pays twice. It is armed when played and consumed by the
 * next graded win, so it is a real effect on the ledger, not a badge. */
// The real World Cup 2026 knockout stage (Round of 32) begins 2026-06-28, after the group stage ends on
// the 27th — this gates the knockout board and the booster reveal to the actual tournament phase, not to
// whatever day the code was written.
export const MYSTERY_REVEAL_ISO = "2026-06-28";
export const KNOCKOUT_START_ISO = "2026-06-28";
export const mysteryRevealed = (now = Date.now()) => now >= Date.parse(MYSTERY_REVEAL_ISO + "T00:00:00Z");
export const knockoutStartMs = Date.parse(KNOCKOUT_START_ISO + "T00:00:00Z");
export const MYSTERY_NAME = "Double Down";
export const MYSTERY_BLURB = "Your next correct call pays double.";

export async function boosterState(userId: string) {
  const day = utcDay();
  await db()`INSERT INTO boosters (user_id, kind, granted_day, ts) VALUES (${userId}, 'mystery', 0, ${Date.now()}) ON CONFLICT DO NOTHING`;
  const m = await db()`SELECT used_day, used_ref FROM boosters WHERE user_id = ${userId} AND kind = 'mystery'`;
  const t = await db()`SELECT used_day, used_ref FROM boosters WHERE user_id = ${userId} AND kind = 'stick_or_twist' AND granted_day = ${day}`;
  const mm = (m as any[])[0];
  return {
    mystery: {
      revealed: mysteryRevealed(),
      name: mysteryRevealed() ? MYSTERY_NAME : null,
      blurb: mysteryRevealed() ? MYSTERY_BLURB : null,
      revealsOn: MYSTERY_REVEAL_ISO,
      armed: mm?.used_ref === "armed",
      spent: mm?.used_ref === "consumed",
      used: mm?.used_day != null,
    },
    move: { usedToday: (t as any[]).length > 0 && (t as any[])[0].used_day != null, ref: (t as any[])[0]?.used_ref ?? null },
  };
}

/** True (and consumed) if this user had Double Down armed — called by the grader when a pick lands. */
export async function consumeMystery(userId: string): Promise<boolean> {
  const rows = await db()`UPDATE boosters SET used_ref = 'consumed'
    WHERE user_id = ${userId} AND kind = 'mystery' AND used_ref = 'armed' RETURNING user_id`;
  return rows.length > 0;
}

/* ─────────────────────────── T6 · Late join + the knockout-only entry ───────────────────────────── */

/** Enrol in the knockout board. Nothing is taken away — it is a clean slate scored only on knockout
 * matches, which is the whole promise: turn up on matchday 3 (or at the quarter-finals) and still win. */
export async function enterKnockouts(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const rows = await db()`UPDATE user_state SET knockout_entry = ${Date.now()}
    WHERE user_id = ${userId} AND knockout_entry IS NULL RETURNING user_id`;
  if (!rows.length) {
    const has = await db()`SELECT knockout_entry FROM user_state WHERE user_id = ${userId}`;
    if ((has as any[])[0]?.knockout_entry) return { ok: false, reason: "You're already in The Decider." };
    return { ok: false, reason: "Couldn't enter — try again." };
  }
  return { ok: true };
}

/** The knockout-only board: points earned from the knockout stage onward, for everyone who entered.
 * Late arrivals are on exactly the same footing as day-one players — that is the point. */
export async function knockoutBoard(userId: string): Promise<{
  entered: boolean; open: boolean; startsOn: string;
  rank: number; size: number; rows: { userId: string; points: number; rank: number; you: boolean }[];
}> {
  const st = await db()`SELECT knockout_entry FROM user_state WHERE user_id = ${userId}`;
  const entered = !!(st as any[])[0]?.knockout_entry;
  const open = Date.now() >= knockoutStartMs;
  const all = await db()`
    SELECT u.user_id, COALESCE(p.pts, 0)::int AS pts
    FROM user_state u
    LEFT JOIN (
      SELECT user_id, SUM(amount)::int AS pts FROM points_events
      WHERE ts >= ${knockoutStartMs} AND amount > 0 GROUP BY user_id
    ) p ON p.user_id = u.user_id
    WHERE u.knockout_entry IS NOT NULL
    ORDER BY pts DESC, u.user_id ASC`;
  const list = (all as any[]).map((r) => ({ userId: r.user_id as string, points: Number(r.pts) }));
  const idx = list.findIndex((r) => r.userId === userId);
  return {
    entered, open, startsOn: KNOCKOUT_START_ISO,
    rank: idx < 0 ? 0 : idx + 1,
    size: list.length,
    rows: list.slice(0, 30).map((r, i) => ({ userId: r.userId, points: r.points, rank: i + 1, you: r.userId === userId })),
  };
}

/** L8 — exactly ONE mid-match move per matchday (boost a live call, or switch your second-half call).
 * Fixed-stake by design: it never escalates what you have at risk (the anti-predatory rule). */
export async function useMove(userId: string, ref: string): Promise<{ ok: boolean; reason?: string }> {
  const day = utcDay();
  const rows = await db()`INSERT INTO boosters (user_id, kind, granted_day, used_day, used_ref, ts)
    VALUES (${userId}, 'stick_or_twist', ${day}, ${day}, ${ref.slice(0, 80)}, ${Date.now()})
    ON CONFLICT (user_id, kind, granted_day) DO NOTHING RETURNING used_day`;
  return rows.length ? { ok: true } : { ok: false, reason: "You've already used your move today." };
}

/** Play the Mystery booster: it ARMS Double Down. The next correct call pays twice, then it's spent. */
export async function useMystery(userId: string): Promise<{ ok: boolean; reason?: string; name?: string }> {
  if (!mysteryRevealed()) return { ok: false, reason: "It opens at the knockouts." };
  const rows = await db()`UPDATE boosters SET used_day = ${utcDay()}, used_ref = 'armed'
    WHERE user_id = ${userId} AND kind = 'mystery' AND used_day IS NULL RETURNING used_day`;
  return rows.length ? { ok: true, name: MYSTERY_NAME } : { ok: false, reason: "You've already played it." };
}

/* ─────────────────────────── C6 / C1 · The wins ledger ──────────────────────────────────────────── */

export async function recordWin(w: {
  sig: string; userId: string; name?: string; fixtureId?: number; market?: string; question?: string;
  stakeLamports?: number; payoutLamports?: number; calledAt?: number | null; settledAfterMs?: number | null;
}) {
  if (!w.sig || !w.userId) return;
  await db()`INSERT INTO wins (sig, user_id, name, fixture_id, market, question, stake_lamports, payout_lamports, called_at, settled_after_ms, ts)
    VALUES (${w.sig}, ${w.userId}, ${(w.name ?? "").slice(0, 40)}, ${w.fixtureId ?? 0}, ${w.market ?? ""}, ${(w.question ?? "").slice(0, 120)},
            ${Math.round(w.stakeLamports ?? 0)}, ${Math.round(w.payoutLamports ?? 0)}, ${w.calledAt ?? null}, ${w.settledAfterMs ?? null}, ${Date.now()})
    ON CONFLICT (sig) DO NOTHING`;
}

/** C1 — record how long after the last proven match event the kernel actually paid. */
export async function recordSettle(market: string, fixtureId: number, matchTs: number, settledAfterMs: number) {
  await db()`INSERT INTO settles (market, fixture_id, match_ts, settled_after_ms, ts)
    VALUES (${market}, ${fixtureId}, ${matchTs}, ${Math.round(settledAfterMs)}, ${Date.now()})
    ON CONFLICT (market) DO NOTHING`;
}
export async function getSettle(market: string) {
  const r = await db()`SELECT fixture_id, match_ts, settled_after_ms FROM settles WHERE market = ${market}`;
  const x = (r as any[])[0];
  return x ? { fixtureId: Number(x.fixture_id), matchTs: Number(x.match_ts), settledAfterMs: Number(x.settled_after_ms) } : null;
}

/** A replayed fixture settles "days after full-time" — true, but meaningless as a brag. Only surface the
 * stat when it describes a real live settlement (inside an hour). We never print a number we can't stand behind. */
export const SETTLE_STAT_MAX_MS = 3_600_000;
export const settleStatUsable = (ms: number | null | undefined) => ms != null && ms >= 0 && ms < SETTLE_STAT_MAX_MS;

/** C6/C1 — record a win, with the PAYOUT taken from the chain, never from the client: it is the owner's
 * real lamport delta on their own claim transaction (fee added back), and the tx is checked to be signed
 * by that user. The stake is the caller's reported figure (the winning Position is consumed by `claim`, so
 * it can't be re-read after the fact) and is used only for the displayed multiplier — it moves no money and
 * grants no points, so a misreported stake distorts one cosmetic ratio and nothing else. */
export async function recordWinFromChain(opts: {
  conn: any; userId: string; sig: string; name?: string; question?: string; market?: string;
  stakeLamports?: number;
}): Promise<{ payout: number; stake: number } | null> {
  const { conn, userId, sig } = opts;
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return null;

  // The claimer is the fee payer (index 0) on their own claim tx.
  let keys: any[];
  const msg: any = tx.transaction.message;
  try { keys = msg.getAccountKeys().staticAccountKeys; } catch { keys = msg.staticAccountKeys || msg.accountKeys || []; }
  if (!keys.length || keys[0].toBase58() !== userId) return null;

  const pre = Number(tx.meta.preBalances?.[0] ?? 0), post = Number(tx.meta.postBalances?.[0] ?? 0);
  const fee = Number(tx.meta.fee ?? 0);
  const payout = post - pre + fee;                      // what actually landed, net of the fee they paid
  if (payout <= 0) return null;

  const market = opts.market ?? "";
  const st = market ? await getStamp(userId, market) : null;
  const se = market ? await getSettle(market) : null;

  await recordWin({
    sig, userId, name: opts.name, market,
    fixtureId: se?.fixtureId ?? 0,
    question: opts.question,
    stakeLamports: opts.stakeLamports ?? 0,
    payoutLamports: payout,
    calledAt: st?.calledAt ?? null,
    settledAfterMs: settleStatUsable(se?.settledAfterMs) ? se!.settledAfterMs : null,
  });
  return { payout, stake: opts.stakeLamports ?? 0 };
}

/** C6 — the public, pseudonymous biggest-wins feed. Names only (never addresses). */
export async function biggestWins(limit = 12) {
  // One row per caller: their best win. A plain ORDER BY payout DESC lets a single person who backed the
  // same pool six times own the whole board — six identical rows, which reads as a bug rather than a
  // leaderboard. Dedup on `user_id` (the identity), NOT the free-text display name: keying on name would
  // collapse two different people who share a name into one row, and would fail to dedup one person who
  // varies their name. `DISTINCT ON` must sort by its key first, so the pruning happens inside and the
  // board is ranked outside.
  const r = await db()`SELECT * FROM (
      SELECT DISTINCT ON (user_id) name, question, stake_lamports, payout_lamports, called_at, settled_after_ms, ts
      FROM wins ORDER BY user_id, payout_lamports DESC, ts DESC
    ) best ORDER BY payout_lamports DESC LIMIT ${Math.min(50, limit)}`;
  return (r as any[]).map((x) => ({
    name: x.name || "A caller",
    question: x.question || "",
    stake: Number(x.stake_lamports) / 1e9,
    payout: Number(x.payout_lamports) / 1e9,
    calledAt: x.called_at == null ? null : Number(x.called_at),
    settledAfterMs: x.settled_after_ms == null ? null : Number(x.settled_after_ms),
    ts: Number(x.ts),
  }));
}

/* ─────────────────────────── Y1 · Foresight record + Called Shot ledger ─────────────────────────── */

export async function foresight(userId: string): Promise<{
  wins: number; losses: number; boldest: number | null; shotsOpened: number; shotsSealed: number;
}> {
  const p = await db()`SELECT correct, COUNT(*)::int AS n FROM picks WHERE user_id = ${userId} AND graded = TRUE GROUP BY correct`;
  let wins = 0, losses = 0;
  for (const r of p as any[]) (r.correct ? (wins = Number(r.n)) : (losses = Number(r.n)));
  // wins from real pools count too (a claim is a settled, proven win)
  const pw = await db()`SELECT COUNT(*)::int AS n FROM wins WHERE user_id = ${userId}`;
  wins += Number((pw as any[])[0]?.n ?? 0);
  // The boldest correct call: the LOWEST consensus % that still landed.
  const b = await db()`SELECT MIN(called_at)::int AS m FROM wins WHERE user_id = ${userId} AND called_at IS NOT NULL`;
  const s = await db()`SELECT
      COUNT(*) FILTER (WHERE revealed = TRUE)::int AS opened,
      COUNT(*) FILTER (WHERE revealed = FALSE OR revealed IS NULL)::int AS sealed
    FROM feed WHERE user_id = ${userId} AND kind = 'shot'`;
  return {
    wins, losses,
    boldest: (b as any[])[0]?.m == null ? null : Number((b as any[])[0].m),
    shotsOpened: Number((s as any[])[0]?.opened ?? 0),
    shotsSealed: Number((s as any[])[0]?.sealed ?? 0),
  };
}

/* ─────────────────────────── T1 / S1 · The consensus stamp ──────────────────────────────────────── */

export async function saveStamp(userId: string, market: string, side: string, calledAt: number, messageId?: string | null, asOf?: number | null) {
  await db()`INSERT INTO stamps (user_id, market, side, called_at, message_id, as_of, ts)
    VALUES (${userId}, ${market}, ${side}, ${Math.round(calledAt)}, ${messageId ?? null}, ${asOf ?? null}, ${Date.now()})
    ON CONFLICT (user_id, market) DO NOTHING`;
}
export async function getStamp(userId: string, market: string) {
  const r = await db()`SELECT side, called_at, message_id, as_of FROM stamps WHERE user_id = ${userId} AND market = ${market}`;
  const x = (r as any[])[0];
  return x ? { side: x.side, calledAt: Number(x.called_at), messageId: x.message_id, asOf: x.as_of == null ? null : Number(x.as_of) } : null;
}
