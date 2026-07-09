/** Telegram mini-app identity.
 *
 * Telegram hands the page an `initData` query string signed by the bot's token. Verifying it is the whole
 * security model of a mini-app: without this check anyone can claim to be any Telegram user by editing a
 * string. The algorithm is Telegram's, verbatim:
 *
 *   secret  = HMAC_SHA256(key: "WebAppData", msg: bot_token)
 *   check   = every "k=v" except `hash`, sorted by k, joined by "\n"
 *   valid   = HMAC_SHA256(key: secret, msg: check) === hash
 *
 * We additionally reject stale payloads: a signature stays valid forever, so a leaked initData would be a
 * permanent credential without an age check.
 */
import "server-only";
import * as crypto from "crypto";

export const MAX_AUTH_AGE_SECS = 24 * 3600;

export type TelegramUser = { id: number; username?: string; firstName?: string };

/** Verify Telegram's initData. Returns the user when the signature and the age both check out. */
export function verifyInitData(initData: string, botToken: string, now = Date.now()): { ok: boolean; reason?: string; user?: TelegramUser } {
  if (!initData) return { ok: false, reason: "missing initData" };
  if (!botToken) return { ok: false, reason: "server has no bot token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };

  const pairs: string[] = [];
  params.forEach((v, k) => { if (k !== "hash") pairs.push(`${k}=${v}`); });
  pairs.sort();
  const checkString = pairs.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

  // Constant-time compare — a timing oracle on a signature check is a real hole, however small.
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate) return { ok: false, reason: "no auth_date" };
  const ageSecs = Math.floor(now / 1000) - authDate;
  if (ageSecs > MAX_AUTH_AGE_SECS) return { ok: false, reason: "expired" };
  if (ageSecs < -300) return { ok: false, reason: "auth_date is in the future" };

  let user: TelegramUser | undefined;
  try {
    const raw = params.get("user");
    if (raw) { const u = JSON.parse(raw); user = { id: Number(u.id), username: u.username, firstName: u.first_name }; }
  } catch { /* a valid signature with an unreadable user block is still not a user */ }
  if (!user?.id) return { ok: false, reason: "no user" };

  return { ok: true, user };
}

/** A stable, non-reversible app id for a Telegram user. We never store their Telegram id directly. */
export function telegramUserId(tgId: number, botToken: string): string {
  return "tg_" + crypto.createHmac("sha256", botToken).update(String(tgId)).digest("hex").slice(0, 24);
}
