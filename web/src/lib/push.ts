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

/** Push every device a user has registered. */
export async function pushUser(userId: string, msg: PushMsg): Promise<number> {
  if (!init()) return 0;
  const rows = await db()`SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ${userId}`;
  return fanOut(rows as any[], msg);
}

/** Push a whole squad — the synchronized-moment fan-out (e.g. a Freeze opening). `exceptUser` skips the
 * person who triggered it so they aren't buzzed about their own action. */
export async function pushSquad(squadCode: string, msg: PushMsg, exceptUser?: string): Promise<number> {
  if (!init()) return 0;
  const rows = exceptUser
    ? await db()`SELECT endpoint, p256dh, auth FROM push_subs WHERE squad_code = ${squadCode} AND user_id <> ${exceptUser}`
    : await db()`SELECT endpoint, p256dh, auth FROM push_subs WHERE squad_code = ${squadCode}`;
  return fanOut(rows as any[], msg);
}

/** Persist (or refresh) a device subscription for a user. */
export async function saveSub(userId: string, sub: any, squadCode: string | null): Promise<void> {
  const { endpoint, keys } = sub || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("bad subscription");
  await db()`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, squad_code, created_at)
    VALUES (${userId}, ${endpoint}, ${keys.p256dh}, ${keys.auth}, ${squadCode}, ${Date.now()})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = ${userId}, squad_code = ${squadCode}, p256dh = ${keys.p256dh}, auth = ${keys.auth}`;
}
