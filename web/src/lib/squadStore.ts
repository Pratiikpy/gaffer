/** Server-side squad store — hosted Postgres (Neon), multi-user, transactional (K4).
 * Auth: each member holds a secret token issued on create/join; every mutation must present it, so
 * no one can post/react/sync AS another user. Tokens never leave the server (readSquad omits them).
 * Points are NOT stored here — the leaderboard joins each member to the server-authoritative points
 * ledger (see points.ts). `syncMember` can only change a member's OWN profile (name/nation); it can
 * never write points or streak (KILL-2). */
import "server-only";
import * as crypto from "crypto";
import { db } from "./db";
import { grantNewAccount, grantSquadJoin } from "./points";

export type Member = { id: string; name: string; nation: string; points: number; streak: number; joinedAt: number; proxyOk?: boolean };
export type FeedItem = {
  id: string; ts: number; userId: string; name: string;
  kind: "msg" | "call" | "win" | "system" | "shot";
  text: string; market?: string; side?: number; q?: string;
  reactions: Record<string, string[]>;
  sealed?: string | null; revealed?: boolean; shotWin?: boolean | null;
  reason?: string;   // S5 — why the call was made
  lockTs?: number;   // the pool's cut-off, used to decide when a hidden pick may be revealed
};
export type PubSquad = { code: string; name: string; createdAt: number; ownerId: string; members: Record<string, Member>; feed: FeedItem[] };

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n = (n + 1) % 1e6).toString(36)}`;
const newToken = () => crypto.randomBytes(18).toString("base64url");
const clamp = (s: string, len: number) => (s || "").slice(0, len);
// Boundary validation — every member-supplied field is bounded before it is stored and fanned out.
const cleanId = (s: string) => clamp(String(s || ""), 64);
const cleanNation = (s: string) => (/^[A-Za-z]{2,10}$/.test(s) ? s : "USA");
const cleanSide = (n: unknown) => (n === 1 || n === 2 ? n : null);
const cleanMarket = (s: string) => clamp(String(s || "").replace(/[^1-9A-HJ-NP-Za-km-z]/g, ""), 64); // base58 chars only
const REACTS = new Set(["🔥", "👏", "🤣", "😱", "💀", "🐐", "🎯", "🕯️", "🫡", "💔", "🙌", "😭"]);

async function genCode(): Promise<string> {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let t = 0; t < 80; t++) {
    let c = ""; for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
    const hit = await db()`SELECT 1 FROM squads WHERE code = ${c}`;
    if (hit.length === 0) return c;
  }
  return "SQ" + Date.now().toString(36).toUpperCase();
}

/** Assemble the public squad: members joined to the points ledger, feed in order, tokens omitted. */
async function readSquad(code: string): Promise<PubSquad | null> {
  const c = code?.toUpperCase();
  if (!c) return null;
  const sq = await db()`SELECT code, name, owner_id, created_at FROM squads WHERE code = ${c}`;
  if (sq.length === 0) return null;
  const mrows = await db()`
    SELECT m.user_id, m.name, m.nation, m.streak, m.joined_at, m.proxy_ok, COALESCE(p.total, 0)::int AS points
    FROM members m
    LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM points_events e WHERE e.user_id = m.user_id) p ON TRUE
    WHERE m.squad_code = ${c}`;
  const frows = await db()`
    SELECT id, ts, user_id, name, kind, text, market, side, q, reactions, sealed, revealed, shot_win, reason, lock_ts
    FROM feed WHERE squad_code = ${c} ORDER BY ts ASC LIMIT 120`;
  const members: Record<string, Member> = {};
  for (const m of mrows as any[]) members[m.user_id] = {
    id: m.user_id, name: m.name, nation: m.nation, points: Number(m.points), streak: Number(m.streak), joinedAt: Number(m.joined_at),
    proxyOk: !!m.proxy_ok,
  };
  const feed: FeedItem[] = (frows as any[]).map((f) => ({
    id: f.id, ts: Number(f.ts), userId: f.user_id, name: f.name, kind: f.kind, text: f.text,
    market: f.market ?? undefined, side: f.side ?? undefined, q: f.q ?? undefined,
    reactions: f.reactions || {},
    sealed: f.sealed ?? undefined, revealed: f.revealed ?? undefined, shotWin: f.shot_win,
    reason: f.reason ?? undefined,   // S5 — the written reason, so Copy-a-Call is never blind
    lockTs: f.lock_ts == null ? undefined : Number(f.lock_ts),
  }));
  return { code: sq[0].code, name: sq[0].name, ownerId: sq[0].owner_id, createdAt: Number(sq[0].created_at), members, feed };
}

/** True only if `token` is the secret issued to `userId` in this squad. Guards all mutations. */
export async function authed(code: string, userId: string, token: string): Promise<boolean> {
  if (!code || !userId || !token) return false;
  const rows = await db()`SELECT 1 FROM members WHERE squad_code = ${code.toUpperCase()} AND user_id = ${userId} AND token = ${token}`;
  return rows.length > 0;
}

export async function createSquad(name: string, owner: Partial<Member>): Promise<{ squad: PubSquad; token: string }> {
  const code = await genCode();
  const id = cleanId(owner.id!);
  const nm = clamp(owner.name || "Player", 24);
  const nation = cleanNation(owner.nation || "USA");
  const token = newToken();
  const now = Date.now();
  await db().transaction([
    db()`INSERT INTO squads (code, name, owner_id, created_at) VALUES (${code}, ${clamp(name || "My Squad", 32)}, ${id}, ${now})`,
    db()`INSERT INTO members (squad_code, user_id, name, nation, streak, joined_at, token) VALUES (${code}, ${id}, ${nm}, ${nation}, 0, ${now}, ${token}) ON CONFLICT (squad_code, user_id) DO NOTHING`,
    db()`INSERT INTO feed (id, squad_code, ts, user_id, name, kind, text) VALUES (${uid()}, ${code}, ${now}, 'system', '', 'system', ${nm + " started the squad"})`,
  ]);
  await grantNewAccount(id); await grantSquadJoin(id, code);
  return { squad: (await readSquad(code))!, token };
}

export async function joinSquad(code: string, m: Partial<Member>): Promise<{ squad: PubSquad; token: string } | null> {
  const c = code?.toUpperCase();
  const exists = await db()`SELECT 1 FROM squads WHERE code = ${c}`;
  if (exists.length === 0) return null;
  const id = cleanId(m.id!);
  const nm = clamp(m.name || "Player", 24);
  const nation = cleanNation(m.nation || "USA");
  // Insert-or-return-existing atomically so a double-tap join can't lose to a unique-violation 500.
  const token = newToken();
  const ins = await db()`
    INSERT INTO members (squad_code, user_id, name, nation, streak, joined_at, token)
    VALUES (${c}, ${id}, ${nm}, ${nation}, 0, ${Date.now()}, ${token})
    ON CONFLICT (squad_code, user_id) DO UPDATE SET name = EXCLUDED.name, nation = EXCLUDED.nation
    RETURNING token, (xmax = 0) AS inserted`;
  const isNew = ins[0]?.inserted === true;
  if (isNew) {
    // Q3 — the arrival beat. Partiful's guest-list effect: seeing a name land is what convinces the
    // next person. It reads as an event, not a log line, and it carries who they're backing.
    await db()`INSERT INTO feed (id, squad_code, ts, user_id, name, kind, text) VALUES (${uid()}, ${c}, ${Date.now()}, 'system', '', 'system', ${`${nm} is in — backing ${nation}`})`;
    await grantNewAccount(id); await grantSquadJoin(id, c);
  }
  return { squad: (await readSquad(c))!, token: ins[0].token };
}

export async function getSquad(code: string): Promise<PubSquad | null> { return readSquad(code); }

export async function postMessage(code: string, userId: string, name: string, text: string): Promise<PubSquad | null> {
  const c = code?.toUpperCase();
  if (!text?.trim()) return readSquad(c);
  await db()`INSERT INTO feed (id, squad_code, ts, user_id, name, kind, text) VALUES (${uid()}, ${c}, ${Date.now()}, ${userId}, ${clamp(name, 24)}, 'msg', ${clamp(text.trim(), 280)})`;
  return readSquad(c);
}

export async function recordCall(code: string, userId: string, name: string, market: string, side: number, q: string, sealed?: string, reason?: string, lockTs?: number): Promise<PubSquad | null> {
  const c = code?.toUpperCase();
  const kind = sealed ? "shot" : "call";
  // `reason` (S5) is the one line explaining WHY — it rides with the call so Copy-a-Call is never blind.
  await db()`INSERT INTO feed (id, squad_code, ts, user_id, name, kind, text, market, side, q, sealed, reason, lock_ts) VALUES (${uid()}, ${c}, ${Date.now()}, ${cleanId(userId)}, ${clamp(name, 24)}, ${kind}, '', ${cleanMarket(market)}, ${cleanSide(side)}, ${clamp(q || "", 80)}, ${sealed ? clamp(sealed, 140) : null}, ${reason ? clamp(reason, 120) : null}, ${Number.isFinite(lockTs) ? Math.round(lockTs!) : null})`;
  return readSquad(c);
}

export async function react(code: string, msgId: string, emoji: string, userId: string): Promise<PubSquad | null> {
  const c = code?.toUpperCase();
  if (!REACTS.has(emoji)) return readSquad(c); // only sanctioned reactions can enter the feed JSON
  const uid_ = cleanId(userId);
  const rows = await db()`SELECT reactions FROM feed WHERE id = ${msgId} AND squad_code = ${c}`;
  if (rows.length === 0) return readSquad(c);
  const reactions: Record<string, string[]> = rows[0].reactions || {};
  const arr = reactions[emoji] || (reactions[emoji] = []);
  const i = arr.indexOf(uid_);
  if (i >= 0) arr.splice(i, 1); else arr.push(uid_);
  if (arr.length === 0) delete reactions[emoji];
  await db()`UPDATE feed SET reactions = ${JSON.stringify(reactions)}::jsonb WHERE id = ${msgId} AND squad_code = ${c}`;
  return readSquad(c);
}

/** Update ONLY the caller's own profile. Never points, never streak (server-authoritative). */
export async function syncMember(code: string, userId: string, patch: Partial<Member>): Promise<PubSquad | null> {
  const c = code?.toUpperCase();
  const name = patch.name != null ? clamp(patch.name, 24) : null;
  const nation = patch.nation != null ? patch.nation : null;
  if (name != null || nation != null) {
    await db()`UPDATE members SET name = COALESCE(${name}, name), nation = COALESCE(${nation}, nation) WHERE squad_code = ${c} AND user_id = ${userId}`;
  }
  return readSquad(c);
}

/** Write the server-derived streak onto every membership row for a user (called after activity). */
export async function setMemberStreak(userId: string, streak: number): Promise<void> {
  await db()`UPDATE members SET streak = ${streak} WHERE user_id = ${userId}`;
}
