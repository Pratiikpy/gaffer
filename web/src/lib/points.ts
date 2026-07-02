/** Server-authoritative points (K3 / KILL-2). Points are a ledger of idempotent events — a user's
 * total is SUM(amount), never a number the client sends. Free-game grants are deduped by the server
 * (one per user per matchday); money grants (stake/win) are VERIFIED on-chain against the signer, so
 * you cannot earn them without a real transaction you actually signed. */
import "server-only";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import * as crypto from "crypto";
import { db } from "./db";
import { RPC, LATCH_PROGRAM } from "./config";

/** Canonical grant schedule (master-spec §5 economy). Amounts live here, server-side, only. */
export const GRANT = {
  new_account: 150,
  free_pick: 50,
  pick_win: 25,
  streak_bonus: 5,
  stake: 3,
  win: 100,
  squad_join: 100,
  share: 50,
  frozen_win: 40, // read a Frozen Window (Freeze/Blackout) round right
} as const;
export type GrantKind = keyof typeof GRANT;

/** Grant Frozen Window round points — idempotent per (user, round). */
export async function grantFrozenWin(userId: string, roundId: string) { return insertGrant(userId, "frozen_win", `frozen:${roundId}`); }

/** First 8 bytes of each LATCH instruction (from the IDL) — grants verify the actual instruction,
 * not merely "a transaction that touched the program", so a join sig can never mint a win grant. */
const IX_DISC: Record<string, number[]> = {
  join_pool: [14, 65, 62, 16, 116, 17, 195, 107],
  join_parlay: [211, 153, 155, 3, 234, 240, 124, 217],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  claim_parlay: [47, 40, 30, 204, 201, 172, 97, 250],
};

export const utcDay = (ms = Date.now()) => Math.floor(ms / 86400000);
const dayRef = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD

/** Insert one idempotent grant. Returns true if it was newly applied (false = already granted). */
async function insertGrant(userId: string, kind: GrantKind, ref: string, squadCode?: string | null): Promise<boolean> {
  if (!userId) return false;
  const amount = GRANT[kind];
  const rows = await db()`
    INSERT INTO points_events (user_id, squad_code, kind, amount, ref, ts)
    VALUES (${userId}, ${squadCode ?? null}, ${kind}, ${amount}, ${ref}, ${Date.now()})
    ON CONFLICT (user_id, kind, ref) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** A user's global points total, straight from the ledger. */
export async function pointsTotal(userId: string): Promise<number> {
  if (!userId) return 0;
  const rows = await db()`SELECT COALESCE(SUM(amount), 0)::int AS total FROM points_events WHERE user_id = ${userId}`;
  return Number(rows[0]?.total ?? 0);
}

/** One-time endowed-progress grant on first sight of a user. */
export async function grantNewAccount(userId: string) { await insertGrant(userId, "new_account", "once"); }
export async function grantSquadJoin(userId: string, squadCode: string) { await insertGrant(userId, "squad_join", "once", squadCode); }
export async function grantShare(userId: string): Promise<boolean> { return insertGrant(userId, "share", "first"); }

/** Per-user secret, minted on first contact and returned to the client once. Every points-mutating
 * request must present it, so a stranger cannot POST grants for someone else's id (KILL-2 hardening).
 * Returns { token, fresh } — fresh=true only on the very first mint (the client stores it then). */
export async function ensureUserToken(userId: string): Promise<{ token: string; fresh: boolean }> {
  const now = Date.now();
  const token = crypto.randomBytes(18).toString("base64url");
  const rows = await db()`
    INSERT INTO user_state (user_id, freezes, created_at, token) VALUES (${userId}, 3, ${now}, ${token})
    ON CONFLICT (user_id) DO UPDATE SET token = COALESCE(user_state.token, EXCLUDED.token)
    RETURNING token, (xmax = 0) AS inserted`;
  const stored = rows[0]?.token as string;
  return { token: stored, fresh: stored === token };
}
/** True only if `token` is this user's secret. Guards every /api/points mutation. */
export async function tokenOk(userId: string, token: string): Promise<boolean> {
  if (!userId || !token) return false;
  const rows = await db()`SELECT 1 FROM user_state WHERE user_id = ${userId} AND token = ${token}`;
  return rows.length > 0;
}

/** Record the free daily pick (side + fixture) and grant the entry points — one per UTC matchday.
 * The pick is stored so it can be graded against the real result later (gradePicks below). */
export async function grantFreePick(userId: string, side: string, fixtureId: number, quest: string, squadCode?: string | null) {
  const clean = side === "yes" || side === "no" ? side : "yes";
  await db()`
    INSERT INTO picks (user_id, day, fixture_id, quest, side, ts)
    VALUES (${userId}, ${utcDay()}, ${Number(fixtureId) || 0}, ${(quest || "").slice(0, 80)}, ${clean}, ${Date.now()})
    ON CONFLICT (user_id, day) DO NOTHING`;
  await insertGrant(userId, "free_pick", `pick:${dayRef()}`, squadCode);
}
/** Grade any ungraded picks for a fixture whose result is known: `hit` = YES was correct. Awards the
 * pick_win bonus to correct YES pickers / correct NO pickers. Idempotent (graded flag + unique ref). */
export async function gradePicks(fixtureId: number, yesWon: boolean): Promise<number> {
  const rows = await db()`SELECT user_id, day, side FROM picks WHERE fixture_id = ${fixtureId} AND graded = FALSE`;
  let graded = 0;
  for (const p of rows as any[]) {
    const correct = (p.side === "yes") === yesWon;
    await db()`UPDATE picks SET graded = TRUE, correct = ${correct} WHERE user_id = ${p.user_id} AND day = ${p.day}`;
    if (correct) await insertGrant(p.user_id, "pick_win", `pickwin:${fixtureId}:${p.day}`);
    graded++;
  }
  return graded;
}
/** Streak-advance bonus — one per user per day, only awarded alongside a recorded activity day. */
export async function grantStreakBonus(userId: string) { await insertGrant(userId, "streak_bonus", `streak:${dayRef()}`); }

/** Verify a transaction (a) succeeded, (b) was fee-paid/signed by `expectedSigner`, and (c) contains
 * a LATCH instruction whose discriminator is one of `allowedIx`. This is the anti-forge core: a win
 * grant demands a real claim instruction, a stake grant a real join — a join sig posted as a "win"
 * is rejected, and the two grant kinds can never both be minted from one signature's instruction. */
async function verifyProgramIx(sig: string, expectedSigner: string, allowedIx: (keyof typeof IX_DISC)[]): Promise<boolean> {
  if (!sig || !expectedSigner) return false;
  try {
    const signerPk = new PublicKey(expectedSigner); // throws on a non-address userId → not granted
    const conn = new Connection(RPC, "confirmed");
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) return false;
    const msg: any = tx.transaction.message;
    // Works for both legacy and v0 messages; our program txs carry no address-table lookups.
    let keys: PublicKey[];
    try { keys = msg.getAccountKeys().staticAccountKeys; }
    catch { keys = msg.staticAccountKeys || msg.accountKeys || []; }
    if (!keys.length) return false;
    // Fee payer (index 0) is always a signer; join's user and claim's owner are both the fee payer.
    if (!keys[0].equals(signerPk)) return false;
    // Collect compiled instructions from either message shape.
    const compiled: { programIdIndex: number; data: string | Uint8Array }[] =
      msg.compiledInstructions ?? msg.instructions ?? [];
    const allowed = allowedIx.map((n) => IX_DISC[n]);
    for (const ix of compiled) {
      if (!keys[ix.programIdIndex]?.equals(LATCH_PROGRAM)) continue;
      const data: Uint8Array = typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data;
      if (data.length < 8) continue;
      if (allowed.some((d) => d.every((b, i) => data[i] === b))) return true;
    }
    return false;
  } catch {
    return false; // a malformed sig / RPC hiccup means "unverified", never a thrown error
  }
}

/** Grant stake points, verified against a real join_pool/join_parlay instruction signed by the user. */
export async function grantStakeVerified(userId: string, sig: string, squadCode?: string | null): Promise<boolean> {
  if (!(await verifyProgramIx(sig, userId, ["join_pool", "join_parlay"]))) return false;
  return insertGrant(userId, "stake", `stake:${sig}`, squadCode);
}
/** Grant win points, verified against a real claim/claim_parlay instruction signed by the user. */
export async function grantWinVerified(userId: string, sig: string, squadCode?: string | null): Promise<boolean> {
  if (!(await verifyProgramIx(sig, userId, ["claim", "claim_parlay"]))) return false;
  return insertGrant(userId, "win", `win:${sig}`, squadCode);
}

/** Record today's activity and return the server-derived current streak (consecutive UTC days,
 * a single-day gap forgiven by spending a held freeze). Server-authoritative — no client streak. */
export async function touchActivityAndStreak(userId: string): Promise<{ streak: number; freezes: number }> {
  if (!userId) return { streak: 0, freezes: 0 };
  const today = utcDay();
  await db()`INSERT INTO user_state (user_id, freezes, created_at) VALUES (${userId}, 3, ${Date.now()}) ON CONFLICT (user_id) DO NOTHING`;
  await db()`INSERT INTO activity_days (user_id, day) VALUES (${userId}, ${today}) ON CONFLICT DO NOTHING`;
  return computeStreak(userId);
}

/** Y2 — the emoji streak grid data: the last `span` UTC days as hit/freeze/miss, plus an honest
 * "share of players whose run is dead" percentile (null when the cohort is too small to be meaningful,
 * so we never print a fabricated-looking stat). Spoiler-free by construction — it's just the streak. */
export async function streakGrid(userId: string, span = 14): Promise<{ cells: ("hit" | "freeze" | "miss")[]; streak: number; alivePct: number | null }> {
  const { streak } = await computeStreak(userId);
  const today = utcDay();
  // Read the full history (not just the window) so `earliest` is correct, plus the original freeze count.
  const allRows = await db()`SELECT day FROM activity_days WHERE user_id = ${userId} ORDER BY day DESC LIMIT 400`;
  const active = new Set(allRows.map((r: any) => Number(r.day)));
  const st = await db()`SELECT freezes FROM user_state WHERE user_id = ${userId}`;
  const budget = Number(st[0]?.freezes ?? 0);
  // Replay the SAME corrected walk to find exactly which gap days a freeze bridged (🧊) — a freeze
  // is never spent past the earliest active day, so pre-history renders as ⬜ not 🧊.
  const bridged = new Set<number>();
  if (active.size > 0 && (active.has(today) || active.has(today - 1))) {
    const earliest = Math.min(...active);
    let cursor = active.has(today) ? today : today - 1, spent = 0;
    while (cursor >= earliest) {
      if (active.has(cursor)) cursor--;
      else if (cursor > earliest && spent < budget) { bridged.add(cursor); spent++; cursor--; }
      else break;
    }
  }
  const cells: ("hit" | "freeze" | "miss")[] = [];
  for (let d = today; d > today - span; d--) cells.push(active.has(d) ? "hit" : bridged.has(d) ? "freeze" : "miss");
  cells.reverse();
  // Cohort "alive" rate: fraction of all players with any history whose last activity was ≥ yesterday.
  const cohort = await db()`SELECT COUNT(DISTINCT user_id)::int AS total, COUNT(DISTINCT user_id) FILTER (WHERE day >= ${today - 1})::int AS alive FROM activity_days`;
  const total = Number(cohort[0]?.total ?? 0), alive = Number(cohort[0]?.alive ?? 0);
  const alivePct = total >= 20 ? Math.round((1 - alive / total) * 100) : null; // % whose run is dead
  return { cells, streak, alivePct };
}

/** Compute the current streak from the activity ledger. Consecutive days back from today; a missed
 * day is bridged only if a held freeze is available AND there is an earlier active day to bridge TO
 * (a freeze never gets spent walking into empty pre-history — that would drain freezes to 0 for a
 * brand-new one-day user). The walk stops at the earliest active day. */
export async function computeStreak(userId: string): Promise<{ streak: number; freezes: number }> {
  const today = utcDay();
  const rows = await db()`SELECT day FROM activity_days WHERE user_id = ${userId} ORDER BY day DESC LIMIT 400`;
  const days = new Set(rows.map((r: any) => Number(r.day)));
  const st = await db()`SELECT freezes FROM user_state WHERE user_id = ${userId}`;
  const freezes = Number(st[0]?.freezes ?? 0);
  if (days.size === 0 || (!days.has(today) && !days.has(today - 1))) return { streak: 0, freezes }; // run broken
  const earliest = Math.min(...days);
  let streak = 0, cursor = days.has(today) ? today : today - 1, spent = 0;
  while (cursor >= earliest) {
    if (days.has(cursor)) { streak++; cursor--; }
    else if (cursor > earliest && freezes - spent > 0) { spent++; cursor--; } // bridge a real gap only
    else break;
  }
  return { streak, freezes: freezes - spent };
}
