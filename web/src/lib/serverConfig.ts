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
/** Explicit dev opt-in to run admin/keeper routes WITHOUT a key. Off by default ⇒ routes fail CLOSED. */
export const ALLOW_OPEN_ADMIN = (process.env.ALLOW_OPEN_ADMIN ?? "0") === "1";

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

/** Admin/keeper route guard. FAIL-CLOSED: with no ADMIN_KEY configured the call is rejected
 * unless ALLOW_OPEN_ADMIN=1 is explicitly set (devnet dev). Otherwise a constant-time header match. */
export function adminOk(req: Request): boolean {
  if (!ADMIN_KEY) return ALLOW_OPEN_ADMIN; // no key: only open if the dev opted in explicitly
  const got = req.headers.get("x-gaffer-key") || "";
  const a = Buffer.from(got), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
