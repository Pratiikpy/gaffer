/** Shell tests: Telegram initData verification (the whole security model of a mini-app) and the
 * Farcaster manifest/embed shape. Pure — no network, no DB. Run: `node scripts/test-shells.mjs` */
import assert from "node:assert";
import * as crypto from "node:crypto";

let n = 0, pass = 0;
const t = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };

const MAX_AUTH_AGE_SECS = 24 * 3600;

/* Mirror of src/lib/telegram.ts */
function verifyInitData(initData, botToken, now = Date.now()) {
  if (!initData) return { ok: false, reason: "missing initData" };
  if (!botToken) return { ok: false, reason: "server has no bot token" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };
  const pairs = [];
  params.forEach((v, k) => { if (k !== "hash") pairs.push(`${k}=${v}`); });
  pairs.sort();
  const checkString = pairs.join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const a = Buffer.from(computed, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate) return { ok: false, reason: "no auth_date" };
  const age = Math.floor(now / 1000) - authDate;
  if (age > MAX_AUTH_AGE_SECS) return { ok: false, reason: "expired" };
  if (age < -300) return { ok: false, reason: "auth_date is in the future" };
  let user;
  try { const raw = params.get("user"); if (raw) { const u = JSON.parse(raw); user = { id: Number(u.id), username: u.username, firstName: u.first_name }; } } catch {}
  if (!user?.id) return { ok: false, reason: "no user" };
  return { ok: true, user };
}

/** Build a correctly-signed initData, the way Telegram would. */
function signInitData(fields, botToken) {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const check = pairs.join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) p.set(k, String(v));
  p.set("hash", hash);
  return p.toString();
}

const TOKEN = "123456:TEST-BOT-TOKEN-abcdefghijklmnop";
const now = Date.now();
const authDate = Math.floor(now / 1000) - 60;
const userJson = JSON.stringify({ id: 777001, username: "kev", first_name: "Kev" });

console.log("Telegram · initData verification:");
t("a correctly-signed payload is accepted, and yields the user", () => {
  const data = signInitData({ auth_date: authDate, query_id: "abc", user: userJson }, TOKEN);
  const r = verifyInitData(data, TOKEN, now);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.user.id, 777001);
  assert.strictEqual(r.user.firstName, "Kev");
});
t("a tampered field is rejected (the signature covers everything)", () => {
  const data = signInitData({ auth_date: authDate, query_id: "abc", user: userJson }, TOKEN);
  const p = new URLSearchParams(data);
  p.set("user", JSON.stringify({ id: 999999, first_name: "Impostor" }));   // swap the user, keep the hash
  assert.strictEqual(verifyInitData(p.toString(), TOKEN, now).ok, false);
});
t("a payload signed with a different bot token is rejected", () => {
  const data = signInitData({ auth_date: authDate, user: userJson }, "999:OTHER-BOT");
  assert.strictEqual(verifyInitData(data, TOKEN, now).ok, false);
});
t("a missing hash is rejected", () => {
  assert.strictEqual(verifyInitData(`auth_date=${authDate}&user=${encodeURIComponent(userJson)}`, TOKEN, now).ok, false);
});
t("a stale payload is rejected (a signature alone is not a session)", () => {
  const old = Math.floor(now / 1000) - (MAX_AUTH_AGE_SECS + 60);
  const data = signInitData({ auth_date: old, user: userJson }, TOKEN);
  const r = verifyInitData(data, TOKEN, now);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "expired");
});
t("an auth_date from the future is rejected", () => {
  const future = Math.floor(now / 1000) + 3600;
  const data = signInitData({ auth_date: future, user: userJson }, TOKEN);
  assert.strictEqual(verifyInitData(data, TOKEN, now).ok, false);
});
t("a valid signature with no user block is not a user", () => {
  const data = signInitData({ auth_date: authDate, query_id: "abc" }, TOKEN);
  const r = verifyInitData(data, TOKEN, now);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no user");
});
t("no bot token configured means nothing is ever accepted", () => {
  const data = signInitData({ auth_date: authDate, user: userJson }, TOKEN);
  assert.strictEqual(verifyInitData(data, "", now).ok, false);
});

console.log("Telegram · the app id is derived, never the raw Telegram id:");
const telegramUserId = (tgId, botToken) => "tg_" + crypto.createHmac("sha256", botToken).update(String(tgId)).digest("hex").slice(0, 24);
t("stable for the same user", () => assert.strictEqual(telegramUserId(777001, TOKEN), telegramUserId(777001, TOKEN)));
t("different users differ", () => assert.notStrictEqual(telegramUserId(777001, TOKEN), telegramUserId(777002, TOKEN)));
t("the raw Telegram id never appears in it", () => assert.ok(!telegramUserId(777001, TOKEN).includes("777001")));


/* ── N3 · bilingual share copy ── */
const detectLang = (nav) => {
  const tags = [nav?.language, ...(nav?.languages ?? [])].filter(Boolean);
  return tags.some((t) => t.toLowerCase().startsWith("es")) ? "es" : "en";
};
console.log("N3 · language detection:");
t("es-MX picks Spanish", () => assert.strictEqual(detectLang({ language: "es-MX" }), "es"));
t("es-419 picks Spanish", () => assert.strictEqual(detectLang({ language: "es-419" }), "es"));
t("en-US picks English", () => assert.strictEqual(detectLang({ language: "en-US" }), "en"));
t("Spanish anywhere in the list wins over an English primary", () => assert.strictEqual(detectLang({ language: "en-GB", languages: ["en-GB", "es-MX"] }), "es"));
t("an unknown locale falls back to English, never a blank card", () => assert.strictEqual(detectLang({ language: "ja-JP" }), "en"));
t("no navigator at all still returns a language", () => assert.strictEqual(detectLang(undefined), "en"));

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
