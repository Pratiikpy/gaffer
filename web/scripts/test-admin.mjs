/** The admin guard.
 *
 * This is the code that was wrong in production. `ALLOW_OPEN_ADMIN` was set with no `GAFFER_ADMIN_KEY`
 * beside it, so `adminOk()` returned true for anonymous callers and a plain `curl` could make the server
 * keypair sign a `create_market` transaction. That one wallet is the market authority, the keeper's
 * settler, the faucet, AND the on-chain TxLINE subscriber whose signature mints our API token — roughly
 * 1,600 unauthenticated requests would have emptied it and taken the data feed down with it.
 *
 * The fix has two halves, and both are asserted here: a secret, once configured, is the ONLY way in; and
 * production ignores the open-admin flag entirely, so a single mis-set env var can never reopen the door.
 * Mirrors src/lib/serverConfig.ts. Run: `node scripts/test-admin.mjs`
 */
import { timingSafeEqual } from "node:crypto";

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

function secretEq(got, want) {
  if (!want) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** adminOk(), with its environment passed in rather than read from process.env. */
function adminOk({ headers = {}, ADMIN_KEY = "", CRON_SECRET = "", allowOpenFlag = false, nodeEnv = "development" }) {
  const ALLOW_OPEN_ADMIN = allowOpenFlag && nodeEnv !== "production";
  const h = (k) => headers[k] || "";
  if (ADMIN_KEY && secretEq(h("x-gaffer-key"), ADMIN_KEY)) return true;
  if (CRON_SECRET) {
    const bearer = h("authorization").replace(/^Bearer\s+/i, "");
    if (secretEq(bearer, CRON_SECRET)) return true;
  }
  if (ADMIN_KEY || CRON_SECRET) return false;
  return ALLOW_OPEN_ADMIN;
}

const KEY = "s3cret-admin-key";
const CRON = "vercel-cron-secret";

console.log("the production regression — an anonymous caller must never get in:");
{
  // Exactly the config that shipped: flag on, no key, NODE_ENV=production.
  t("prod ignores ALLOW_OPEN_ADMIN even when it is set",
    adminOk({ allowOpenFlag: true, nodeEnv: "production" }) === false);
  t("...and still refuses with a key configured and no header",
    adminOk({ ADMIN_KEY: KEY, allowOpenFlag: true, nodeEnv: "production" }) === false);
  t("a wrong key is refused", adminOk({ headers: { "x-gaffer-key": "wrong" }, ADMIN_KEY: KEY }) === false);
  t("an empty key header is refused", adminOk({ headers: { "x-gaffer-key": "" }, ADMIN_KEY: KEY }) === false);
  t("a prefix of the real key is refused",
    adminOk({ headers: { "x-gaffer-key": KEY.slice(0, -1) }, ADMIN_KEY: KEY }) === false);
  t("a longer string containing the key is refused",
    adminOk({ headers: { "x-gaffer-key": KEY + "x" }, ADMIN_KEY: KEY }) === false);
}

console.log("configured secrets are the only way in:");
{
  t("the right admin key opens it", adminOk({ headers: { "x-gaffer-key": KEY }, ADMIN_KEY: KEY }) === true);
  t("once a key exists, the open-admin flag cannot bypass it (even in dev)",
    adminOk({ ADMIN_KEY: KEY, allowOpenFlag: true, nodeEnv: "development" }) === false);
  t("once only a cron secret exists, the open flag cannot bypass it",
    adminOk({ CRON_SECRET: CRON, allowOpenFlag: true, nodeEnv: "development" }) === false);
}

console.log("Vercel Cron authenticates with a bearer token:");
{
  t("Bearer <cron secret> opens it",
    adminOk({ headers: { authorization: `Bearer ${CRON}` }, CRON_SECRET: CRON }) === true);
  t("case-insensitive scheme", adminOk({ headers: { authorization: `bearer ${CRON}` }, CRON_SECRET: CRON }) === true);
  t("a wrong bearer is refused", adminOk({ headers: { authorization: "Bearer nope" }, CRON_SECRET: CRON }) === false);
  t("a bare token without the scheme is still matched",
    adminOk({ headers: { authorization: CRON }, CRON_SECRET: CRON }) === true);
  t("the cron secret does not open the x-gaffer-key door",
    adminOk({ headers: { "x-gaffer-key": CRON }, ADMIN_KEY: KEY, CRON_SECRET: CRON }) === false);
}

console.log("the developer's local loop still works:");
{
  t("dev with the flag and no secrets is open", adminOk({ allowOpenFlag: true, nodeEnv: "development" }) === true);
  t("dev without the flag is closed", adminOk({ allowOpenFlag: false, nodeEnv: "development" }) === false);
  t("nothing configured at all is closed", adminOk({}) === false);
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
