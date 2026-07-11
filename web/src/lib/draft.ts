/** Q7 — THE ROUND TABLE.
 *
 * A per-round snake draft of the surviving nations, on a shared clock. Draft night is what sustains a
 * twenty-five-year league, and the dark days between rounds are dead air this product can own.
 *
 * The rules, and why:
 *  - **Wooden spoon picks first.** The order is by squad points ASCENDING, so the person losing gets the
 *    first pick of the next round. It is the only ordering that keeps a draft worth turning up to.
 *  - **Snake.** Within a round the order reverses on the second lap, so first pick does not also get the
 *    best of the leftovers.
 *  - **No duplicates.** A nation belongs to one person; the unique index enforces it, not the UI.
 *  - **A shared clock.** Everyone watches the same countdown. When it expires the pick is made FOR you
 *    from what's left, because a draft that stalls on one person is a draft nobody finishes.
 */
import "server-only";
import { db } from "./db";
import { txline } from "./txline";

export const PICK_SECS = 40;

export type DraftView = {
  id: string; squadCode: string; round: number; state: "live" | "done";
  order: { pickNo: number; userId: string; name: string }[];
  picks: { nation: string; userId: string; name: string; pickNo: number; auto: boolean }[];
  available: string[];
  onTheClock: { userId: string; name: string; pickNo: number } | null;
  deadline: number; pickSecs: number; msLeft: number;
  totalPicks: number;
};

const newId = () => `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Snake order over `laps` laps: 1..n, then n..1, then 1..n … */
export function snakeOrder<T>(seed: T[], laps: number): T[] {
  const out: T[] = [];
  for (let lap = 0; lap < laps; lap++) {
    const row = lap % 2 === 0 ? seed : [...seed].reverse();
    out.push(...row);
  }
  return out;
}

/** Start a draft for a squad. Order = squad members by points ASCENDING (wooden spoon first). */
export async function startDraft(squadCode: string, nations: string[], round = 1, pickSecs = PICK_SECS): Promise<DraftView | null> {
  const live = await db()`SELECT id FROM drafts WHERE squad_code = ${squadCode} AND state = 'live'`;
  if (live.length) return getDraft((live as any[])[0].id);

  const members = await db()`
    SELECT m.user_id, m.name, COALESCE(p.total, 0)::int AS points
    FROM members m
    LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM points_events e WHERE e.user_id = m.user_id) p ON TRUE
    WHERE m.squad_code = ${squadCode}
    ORDER BY points ASC, m.user_id ASC`;                       // wooden spoon first
  const seed = (members as any[]).map((m) => ({ userId: m.user_id as string, name: (m.name as string) || "Player" }));
  if (seed.length < 2) return null;                             // a draft needs a room

  // Enough laps that every nation on the board can be taken, capped so it stays an evening not a season.
  const laps = Math.max(1, Math.min(4, Math.floor(nations.length / seed.length)));
  const order = snakeOrder(seed, laps);

  const id = newId(), now = Date.now();
  await db()`INSERT INTO drafts (id, squad_code, round, state, pick_index, deadline, pick_secs, created_at)
    VALUES (${id}, ${squadCode}, ${round}, 'live', 0, ${now + pickSecs * 1000}, ${pickSecs}, ${now})`;
  await Promise.all(order.map((o, i) =>
    db()`INSERT INTO draft_order (draft_id, pick_no, user_id, name) VALUES (${id}, ${i}, ${o.userId}, ${o.name})`));
  return getDraft(id);
}

/** The pool for this draft: the nations offered, minus anything already taken. */
async function poolFor(draftId: string, nations: string[]): Promise<string[]> {
  const taken = new Set((await db()`SELECT nation FROM draft_picks WHERE draft_id = ${draftId}`).map((r: any) => r.nation));
  return nations.filter((n) => !taken.has(n));
}

/** Read a draft, advancing the clock: any expired turn is auto-picked so the room is never stuck. */
export async function getDraft(draftId: string, nations?: string[]): Promise<DraftView | null> {
  const rows = await db()`SELECT * FROM drafts WHERE id = ${draftId}`;
  if (!rows.length) return null;
  let d = (rows as any[])[0];

  const order = (await db()`SELECT pick_no, user_id, name FROM draft_order WHERE draft_id = ${draftId} ORDER BY pick_no`)
    .map((r: any) => ({ pickNo: Number(r.pick_no), userId: r.user_id, name: r.name }));
  const board = nations ?? (await boardNations());

  // Auto-pick every turn whose clock has run out (a client that never returns must not freeze the draft).
  let guard = 0;
  while (d.state === "live" && Date.now() >= Number(d.deadline) && guard++ < order.length) {
    const slot = order[Number(d.pick_index)];
    if (!slot) break;
    const left = await poolFor(draftId, board);
    if (!left.length) { await db()`UPDATE drafts SET state = 'done' WHERE id = ${draftId}`; break; }
    await commitPick(draftId, slot.userId, slot.name, left[0], Number(d.pick_index), true);
    d = await advance(draftId, order.length);
  }

  const picks = (await db()`SELECT nation, user_id, name, pick_no, auto FROM draft_picks WHERE draft_id = ${draftId} ORDER BY pick_no`)
    .map((r: any) => ({ nation: r.nation, userId: r.user_id, name: r.name, pickNo: Number(r.pick_no), auto: !!r.auto }));
  const available = board.filter((n) => !picks.some((p) => p.nation === n));
  const cur = d.state === "live" ? order[Number(d.pick_index)] ?? null : null;

  return {
    id: d.id, squadCode: d.squad_code, round: Number(d.round), state: d.state,
    order, picks, available,
    onTheClock: cur ? { userId: cur.userId, name: cur.name, pickNo: cur.pickNo } : null,
    deadline: Number(d.deadline), pickSecs: Number(d.pick_secs),
    msLeft: Math.max(0, Number(d.deadline) - Date.now()),
    totalPicks: order.length,
  };
}

async function commitPick(draftId: string, userId: string, name: string, nation: string, pickNo: number, auto: boolean) {
  // The unique indexes are the real rule: one nation per draft, one pick per slot.
  await db()`INSERT INTO draft_picks (draft_id, nation, user_id, name, pick_no, auto, ts)
    VALUES (${draftId}, ${nation}, ${userId}, ${name.slice(0, 40)}, ${pickNo}, ${auto}, ${Date.now()})
    ON CONFLICT DO NOTHING`;
}

async function advance(draftId: string, total: number) {
  // `Date.now()` must be cast: Postgres infers int4 for a bare parameter next to `pick_secs * 1000`,
  // and an epoch in milliseconds overflows int4. Without the cast every advance throws.
  const rows = await db()`
    UPDATE drafts SET pick_index = pick_index + 1,
      deadline = ${Date.now()}::bigint + pick_secs * 1000,
      state = CASE WHEN pick_index + 1 >= ${total} THEN 'done' ELSE state END
    WHERE id = ${draftId} RETURNING *`;
  return (rows as any[])[0];
}

/** Make a pick. Only the person on the clock may pick, and only something still on the board. */
export async function makePick(draftId: string, userId: string, nation: string, nations?: string[]): Promise<{ ok: boolean; reason?: string; draft?: DraftView }> {
  const view = await getDraft(draftId, nations);
  if (!view) return { ok: false, reason: "That draft is over." };
  if (view.state !== "live") return { ok: false, reason: "That draft is over." };
  if (!view.onTheClock) return { ok: false, reason: "Nobody is on the clock." };
  if (view.onTheClock.userId !== userId) return { ok: false, reason: `It's ${view.onTheClock.name}'s pick.` };
  if (!view.available.includes(nation)) return { ok: false, reason: "Someone's already taken them." };

  await commitPick(draftId, userId, view.onTheClock.name, nation, view.onTheClock.pickNo, false);
  await advance(draftId, view.totalPicks);
  return { ok: true, draft: (await getDraft(draftId, nations))! };
}

/** The live draft for a squad, if there is one. */
export async function liveDraft(squadCode: string, nations?: string[]): Promise<DraftView | null> {
  const rows = await db()`SELECT id FROM drafts WHERE squad_code = ${squadCode} ORDER BY created_at DESC LIMIT 1`;
  if (!rows.length) return null;
  return getDraft((rows as any[])[0].id, nations);
}

/** Who owns a nation in this squad's latest draft — used to credit real results to a drafter. */
export async function nationOwners(squadCode: string): Promise<Record<string, { userId: string; name: string }>> {
  const rows = await db()`
    SELECT p.nation, p.user_id, p.name FROM draft_picks p
    JOIN drafts d ON d.id = p.draft_id
    WHERE d.squad_code = ${squadCode}
    ORDER BY d.created_at DESC`;
  const out: Record<string, { userId: string; name: string }> = {};
  for (const r of rows as any[]) if (!out[r.nation]) out[r.nation] = { userId: r.user_id, name: r.name };
  return out;
}

/** The nations a draft can offer — the teams ACTUALLY in the tournament, read from the live TxLINE
 * schedule (both participants of every fixture), so a squad drafts real, current nations rather than a
 * stale hand-typed list. Falls back to a canonical real-World-Cup set only if the feed is unavailable —
 * never test data. */
export async function boardNations(): Promise<string[]> {
  try {
    const fx = await txline().fixturesSnapshot();
    const nations = new Set<string>();
    for (const f of fx as any[]) { if (f?.Participant1) nations.add(String(f.Participant1)); if (f?.Participant2) nations.add(String(f.Participant2)); }
    if (nations.size >= 8) return [...nations].sort();
  } catch { /* fall through to the canonical set */ }
  return [
    "USA", "Brazil", "Argentina", "France", "England", "Spain", "Germany", "Netherlands",
    "Portugal", "Belgium", "Croatia", "Morocco", "Mexico", "Japan", "Italy", "Norway",
  ];
}
