/** Squad depth: Fade Duels (S6), commissioner tools (Q9), and the lore wall (Q2).
 *
 * Duels used to live in localStorage, which meant the "persistent named H2H ledger" was neither
 * persistent nor shared — the person you faded never saw it. They live here now, keyed to the squad and
 * the market, so both sides see the same duel and it settles itself off the pool's real result.
 *
 * The commissioner is the product's real customer: the person who drags fourteen mates in. They get
 * the controls that make running a pool bearable — remove someone, call on behalf of a member who
 * can't, hide picks until lock, and pin what the squad is actually playing for. */
import "server-only";
import { db } from "./db";

/* ─────────────────────────── S6 · Fade Duels ────────────────────────────────────────────────────── */

export type Duel = {
  id: number; squadCode: string; market: string; question: string;
  a: { userId: string; name: string; side: number };
  b: { userId: string; name: string; side: number };
  status: "live" | "settled"; winner: string | null; ts: number;
};

const row2duel = (r: any): Duel => ({
  id: Number(r.id), squadCode: r.squad_code, market: r.market, question: r.question,
  a: { userId: r.a_user, name: r.a_name, side: Number(r.a_side) },
  b: { userId: r.b_user, name: r.b_name, side: Number(r.b_side) },
  status: r.status, winner: r.winner, ts: Number(r.ts),
});

/** Fade someone: create the duel. Ordered so (A,B) and (B,A) are the same row — you cannot fade the
 * same person twice on the same market, from either direction. */
export async function createDuel(opts: {
  squadCode: string; market: string; question: string;
  a: { userId: string; name: string; side: number };
  b: { userId: string; name: string; side: number };
}): Promise<Duel | null> {
  const { squadCode, market, question } = opts;
  if (opts.a.userId === opts.b.userId) return null;                 // you cannot fade yourself
  if (opts.a.side === opts.b.side) return null;                     // a duel needs two sides
  // canonical order by userId so the unique index actually catches the mirror
  const [a, b] = opts.a.userId < opts.b.userId ? [opts.a, opts.b] : [opts.b, opts.a];
  const rows = await db()`
    INSERT INTO duels (squad_code, a_user, a_name, a_side, b_user, b_name, b_side, market, question, status, ts)
    VALUES (${squadCode}, ${a.userId}, ${a.name.slice(0, 40)}, ${a.side}, ${b.userId}, ${b.name.slice(0, 40)}, ${b.side},
            ${market}, ${question.slice(0, 120)}, 'live', ${Date.now()})
    ON CONFLICT (squad_code, market, a_user, b_user) DO NOTHING
    RETURNING *`;
  return rows.length ? row2duel(rows[0]) : null;
}

export async function listDuels(squadCode: string, userId?: string): Promise<Duel[]> {
  const rows = userId
    ? await db()`SELECT * FROM duels WHERE squad_code = ${squadCode} AND (a_user = ${userId} OR b_user = ${userId}) ORDER BY ts DESC LIMIT 40`
    : await db()`SELECT * FROM duels WHERE squad_code = ${squadCode} ORDER BY ts DESC LIMIT 40`;
  return (rows as any[]).map(row2duel);
}

/** Settle every live duel on a market whose pool has resolved. `winningSide` is 1 (YES) or 2 (NO);
 * pass 0 for a void, which settles the duel to nobody. Idempotent — a settled duel is never touched. */
export async function settleDuelsForMarket(market: string, winningSide: number): Promise<number> {
  const rows = await db()`SELECT * FROM duels WHERE market = ${market} AND status = 'live'`;
  let n = 0;
  // Per-row guard: one bad row must not throw the whole loop and orphan every other duel on the market.
  // Nothing retries this — the keeper never revisits a market once its pool is settled on-chain — so a
  // failure here is permanent. Settle what we can; a stuck row stays 'live' rather than taking the rest down.
  for (const r of rows as any[]) {
    try {
      const d = row2duel(r);
      const winner = winningSide === 0 ? "void" : d.a.side === winningSide ? d.a.userId : d.b.side === winningSide ? d.b.userId : "void";
      await db()`UPDATE duels SET status = 'settled', winner = ${winner} WHERE id = ${d.id} AND status = 'live'`;
      n++;
    } catch { /* leave this duel live; settling the others matters more than failing atomically */ }
  }
  return n;
}

/** The standing head-to-head between two people in a squad: "Dev leads Sam 7–4". */
export async function h2hRecord(squadCode: string, x: string, y: string): Promise<{ x: number; y: number; draws: number }> {
  const rows = await db()`SELECT winner FROM duels WHERE squad_code = ${squadCode} AND status = 'settled'
    AND ((a_user = ${x} AND b_user = ${y}) OR (a_user = ${y} AND b_user = ${x}))`;
  let xw = 0, yw = 0, draws = 0;
  for (const r of rows as any[]) (r.winner === x ? xw++ : r.winner === y ? yw++ : draws++);
  return { x: xw, y: yw, draws };
}

/** REMATCH — the same two people, a new market. Just a duel with a fresh market id; the H2H accrues. */
export const rematch = createDuel;

/* ─────────────────────────── Q9 · Commissioner tools ────────────────────────────────────────────── */

export async function isOwner(squadCode: string, userId: string): Promise<boolean> {
  const r = await db()`SELECT 1 FROM squads WHERE code = ${squadCode} AND owner_id = ${userId}`;
  return r.length > 0;
}

/** Remove a member. The owner cannot remove themselves — a squad always has someone responsible. */
export async function kickMember(squadCode: string, ownerId: string, targetId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isOwner(squadCode, ownerId))) return { ok: false, reason: "Only the squad owner can do that." };
  if (ownerId === targetId) return { ok: false, reason: "You can't remove yourself — hand the squad over first." };
  const r = await db()`DELETE FROM members WHERE squad_code = ${squadCode} AND user_id = ${targetId} RETURNING user_id`;
  if (!r.length) return { ok: false, reason: "They're not in this squad." };
  await db()`INSERT INTO feed (squad_code, ts, user_id, name, kind, text)
    VALUES (${squadCode}, ${Date.now()}, ${ownerId}, 'Squad', 'system', 'A member was removed by the owner.')`;
  return { ok: true };
}

/** Allow the commissioner to call on someone's behalf ("my grandparents play and need me to do this"). */
export async function setProxy(squadCode: string, ownerId: string, targetId: string, allow: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isOwner(squadCode, ownerId))) return { ok: false, reason: "Only the squad owner can do that." };
  const r = await db()`UPDATE members SET proxy_ok = ${allow} WHERE squad_code = ${squadCode} AND user_id = ${targetId} RETURNING user_id`;
  return r.length ? { ok: true } : { ok: false, reason: "They're not in this squad." };
}
export async function proxyAllowed(squadCode: string, ownerId: string, targetId: string): Promise<boolean> {
  if (!(await isOwner(squadCode, ownerId))) return false;
  const r = await db()`SELECT proxy_ok FROM members WHERE squad_code = ${squadCode} AND user_id = ${targetId}`;
  return !!(r as any[])[0]?.proxy_ok;
}

export async function setPicksVisible(squadCode: string, ownerId: string, mode: "always" | "after_lock"): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isOwner(squadCode, ownerId))) return { ok: false, reason: "Only the squad owner can do that." };
  await db()`UPDATE squads SET picks_visible = ${mode} WHERE code = ${squadCode}`;
  return { ok: true };
}

export async function setPrizeNote(squadCode: string, ownerId: string, note: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isOwner(squadCode, ownerId))) return { ok: false, reason: "Only the squad owner can do that." };
  await db()`UPDATE squads SET prize_note = ${note.slice(0, 140)} WHERE code = ${squadCode}`;
  return { ok: true };
}

export async function squadSettings(squadCode: string) {
  const r = await db()`SELECT owner_id, prize_note, picks_visible, is_nation_room FROM squads WHERE code = ${squadCode}`;
  const s = (r as any[])[0];
  return s ? { ownerId: s.owner_id as string, prizeNote: s.prize_note as string | null, picksVisible: s.picks_visible as string, isNationRoom: !!s.is_nation_room } : null;
}

/* ─────────────────────────── Q2 · The lore wall ─────────────────────────────────────────────────── */

/** Name a moment the way a squad would tell it later. Built from what actually happened — the minute,
 * the kind of window, whether the room read it right — never a generic "great moment!". */
export function nameMoment(opts: { kind: string; minute: number | null; roomRight: boolean | null; note?: string }): { title: string; detail: string } {
  const min = opts.minute != null && opts.minute > 0 ? `${opts.minute}th-Minute` : "";
  const what = opts.kind === "blackout" ? "Blackout" : "Freeze";
  const late = opts.minute != null && opts.minute >= 85;
  const title = [min, what].filter(Boolean).join(" ") || (late ? "The Late Window" : `The ${what}`);
  const detail =
    opts.roomRight === true ? "The room called it. Everyone knew." :
    opts.roomRight === false ? "The room got it wrong. Nobody saw it coming." :
    opts.note || "It went quiet, and then it didn't.";
  return { title: `The ${title}`, detail };
}

export async function pinLore(squadCode: string, roundId: string | null, title: string, detail: string, minute: number | null) {
  await db()`INSERT INTO lore (squad_code, round_id, title, detail, minute, ts)
    VALUES (${squadCode}, ${roundId}, ${title.slice(0, 80)}, ${detail.slice(0, 160)}, ${minute}, ${Date.now()})
    ON CONFLICT DO NOTHING`;
}

export async function listLore(squadCode: string) {
  const r = await db()`SELECT title, detail, minute, ts FROM lore WHERE squad_code = ${squadCode} ORDER BY ts DESC LIMIT 12`;
  return (r as any[]).map((x) => ({ title: x.title, detail: x.detail, minute: x.minute == null ? null : Number(x.minute), ts: Number(x.ts) }));
}
