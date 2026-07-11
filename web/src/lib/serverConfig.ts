import "server-only";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";

/**
 * Server-only configuration. The `server-only` import makes the build fail if any of this is
 * ever pulled into a client bundle — so the keypair path and admin key can never ship to the browser.
 */

/** Path to the server keypair (TxLINE subscriber + market authority + keeper settler). */
export const SERVER_KEYPAIR = process.env.GAFFER_KEYPAIR || "../.devnet-key.json";

/** Shared secret guarding admin/keeper routes (create-market, settle*). */
export const ADMIN_KEY = process.env.GAFFER_ADMIN_KEY || "";

/** Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET`, not our header. */
export const CRON_SECRET = process.env.CRON_SECRET || "";

/** Explicit dev opt-in to run admin/keeper routes WITHOUT a key.
 *
 * Honoured ONLY outside production. This is deliberate belt-and-braces: the admin routes make the server
 * keypair sign transactions, and that one wallet is the market authority, the keeper's settler, the
 * faucet, AND the on-chain TxLINE subscriber whose signature mints our API token. Left open, an anonymous
 * `POST /api/create-market` costs it ~0.0026 SOL a call — a few thousand curls and the pools stop
 * settling, the faucet dries up and the data feed dies with it. That is exactly what shipped: the flag
 * was set in production with no key beside it. A single wrong env var must never be able to do that
 * again, so production ignores the flag outright rather than trusting it to be unset.
 */
export const ALLOW_OPEN_ADMIN =
  (process.env.ALLOW_OPEN_ADMIN ?? "0") === "1" && process.env.NODE_ENV !== "production";

/** Faucet hard cap (lamports) — the amount is server-controlled; callers cannot request more. */
export const FAUCET_MAX_LAMPORTS = Math.round(Number(process.env.FAUCET_MAX_SOL || "0.1") * 1e9);
/** Faucet kill-switch. Off in production (funding goes through the on-ramp), on by default for devnet. */
export const FAUCET_ENABLED = (process.env.FAUCET_ENABLED ?? "1") === "1";

/** Secret key as a JSON byte array — the serverless path (Vercel has no repo files). This is a
 * throwaway DEVNET wallet (market authority + keeper + faucet); acceptable to hold in a devnet
 * deploy's env, and the only way the faucet/settle routes can run on serverless. */
export const SERVER_KEYPAIR_SECRET = process.env.GAFFER_KEYPAIR_SECRET || "";

let _kp: Keypair | null = null;
export function loadServerKeypair(): Keypair {
  if (!_kp) {
    const raw = SERVER_KEYPAIR_SECRET
      ? SERVER_KEYPAIR_SECRET                                    // serverless: key bytes from env
      : fs.readFileSync(path.resolve(process.cwd(), SERVER_KEYPAIR), "utf8"); // local: key file
    _kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  }
  return _kp;
}

/** Constant-time compare that never leaks length through `timingSafeEqual`'s own throw. */
export function secretEq(got: string, want: string): boolean {
  if (!want) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Admin/keeper route guard. FAIL-CLOSED.
 *
 * Accepts either our own `x-gaffer-key` header or Vercel Cron's `Authorization: Bearer $CRON_SECRET`,
 * so the scheduled settler authenticates without a second shared secret rattling around. With neither
 * configured, the call is rejected unless a developer explicitly opted in via ALLOW_OPEN_ADMIN — which
 * production ignores (see above).
 */
export function adminOk(req: Request): boolean {
  if (ADMIN_KEY && secretEq(req.headers.get("x-gaffer-key") || "", ADMIN_KEY)) return true;
  if (CRON_SECRET) {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (secretEq(bearer, CRON_SECRET)) return true;
  }
  if (ADMIN_KEY || CRON_SECRET) return false; // a secret exists ⇒ it is the only way in
  return ALLOW_OPEN_ADMIN;                    // nothing configured ⇒ dev-only opt-in, never in prod
}
