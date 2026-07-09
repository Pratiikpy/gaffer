/** Web-push (VAPID) — the server side of GAFFER alerts. Subscriptions live in `push_subs`; a Frozen
 * Window opening for a squad, or a win landing, fans a notification out to the relevant devices. Dead
 * subscriptions (410/404) are pruned on send so the table self-heals. No-ops cleanly if VAPID is unset. */
import "server-only";
import webpush from "web-push";
import { db } from "./db";

let ready = false;
function init(): boolean {
  if (ready) return true;
  const pub = process.env.VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@gaffer.app", pub, priv);
  ready = true;
  return true;
}

export type PushMsg = { title: string; body: string; url?: string; tag?: string };

async function fanOut(rows: any[], msg: PushMsg): Promise<number> {
  if (!init() || rows.length === 0) return 0;
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "/", tag: msg.tag || "gaffer" });
  let sent = 0;
  await Promise.all(rows.map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e: any) {
      // A gone endpoint (unsubscribed / expired) → prune it so the table stays clean.
      if (e?.statusCode === 410 || e?.statusCode === 404) await db()`DELETE FROM push_subs WHERE endpoint = ${s.endpoint}`;
    }
  }));
  return sent;
}

/* ─────────────────────────── K6 · the push budget ──────────────────────────────────────────────────
 * The darkest churn quote in the whole review corpus is a person leaving because an app would not stop
 * buzzing them. So the budget is enforced here, in the code, not promised in a document:
 *
 *   - Class A ("you won") is always allowed. Nobody ever resented being told they got paid.
 *   - Class B (everything else) is capped at MAX_PER_MATCH per match, per person.
 *   - The same beat is never sent twice: `tag` is unique per user, so a retry or a double-poll can't
 *     buzz you again.
 *   - Two matches running at once do not each get a budget's worth of attention — the scope is the match,
 *     and an uninvolved person is not pushed at all (callers pass only involved users).
 */
export const MAX_PER_MATCH = 4;
export type PushClass = "A" | "B";

/** Claim a slot in the budget. Returns true only if this exact push is allowed to go out, once. */
async function claimBudget(userId: string, scope: string, tag: string, cls: PushClass): Promise<boolean> {
  // Dedupe first: the unique index means a repeated tag simply loses.
  const claimed = await db()`INSERT INTO push_log (user_id, scope, tag, class, ts)
    VALUES (${userId}, ${scope}, ${tag}, ${cls}, ${Date.now()})
    ON CONFLICT (user_id, tag) DO NOTHING RETURNING id`;
  if (!claimed.length) return false;
  if (cls === "A") return true;

  // Budget check AFTER the row exists, so two concurrent sends can't both see "3 used" and both pass.
  const used = await db()`SELECT COUNT(*)::int AS n FROM push_log
    WHERE user_id = ${userId} AND scope = ${scope} AND class = 'B'`;
  if (Number((used as any[])[0]?.n ?? 0) <= MAX_PER_MATCH) return true;

  // Over budget: give the slot back so a later, better beat can use the tag space.
  await db()`DELETE FROM push_log WHERE user_id = ${userId} AND tag = ${tag}`;
  return false;
}

/** Push one user, subject to the budget. `scope` is the match; `cls` "A" means a win (never budgeted). */
export async function pushUser(userId: string, msg: PushMsg, scope = "global", cls: PushClass = "B"): Promise<number> {
  if (!init()) return 0;
  if (!(await claimBudget(userId, scope, msg.tag || `${scope}:${msg.title}`, cls))) return 0;
  const rows = await db()`SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ${userId}`;
  return fanOut(rows as any[], msg);
}

/** Push a whole squad — the synchronized-moment fan-out (e.g. a Freeze opening). `exceptUser` skips the
 * person who triggered it so they aren't buzzed about their own action. Each member is budgeted
 * individually, so one loud match cannot spend everyone's quiet. */
export async function pushSquad(squadCode: string, msg: PushMsg, exceptUser?: string, scope = "global", cls: PushClass = "B"): Promise<number> {
  if (!init()) return 0;
  const rows = exceptUser
    ? await db()`SELECT user_id, endpoint, p256dh, auth FROM push_subs WHERE squad_code = ${squadCode} AND user_id <> ${exceptUser}`
    : await db()`SELECT user_id, endpoint, p256dh, auth FROM push_subs WHERE squad_code = ${squadCode}`;

  const tag = msg.tag || `${scope}:${msg.title}`;
  const allowed: any[] = [];
  for (const r of rows as any[]) if (await claimBudget(r.user_id, scope, tag, cls)) allowed.push(r);
  return fanOut(allowed, msg);
}

/** Persist (or refresh) a device subscription for a user. */
export async function saveSub(userId: string, sub: any, squadCode: string | null): Promise<void> {
  const { endpoint, keys } = sub || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("bad subscription");
  await db()`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, squad_code, created_at)
    VALUES (${userId}, ${endpoint}, ${keys.p256dh}, ${keys.auth}, ${squadCode}, ${Date.now()})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = ${userId}, squad_code = ${squadCode}, p256dh = ${keys.p256dh}, auth = ${keys.auth}`;
}
