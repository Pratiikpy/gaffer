import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC } from "@/lib/config";
import { loadServerKeypair, FAUCET_MAX_LAMPORTS, FAUCET_ENABLED } from "@/lib/serverConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rolling 24h drain ceiling (per server process). Bounds a spray of fresh addresses to DAILY_CAP
// total — the per-address balance guard alone did not (N wallets = N×amount). Per-IP limiting /
// turnstile still belongs at the edge in production; this is the process-level backstop.
const DAILY_CAP_LAMPORTS = FAUCET_MAX_LAMPORTS * 200;
let _windowStart = 0;
let _spent = 0;

// Per-IP backstop: at most a few grants per IP per rolling hour, so one host can't walk the whole
// daily cap by spraying fresh addresses. (Edge Turnstile via TURNSTILE_SECRET is the production layer;
// this in-process guard always applies.) A bounded map keeps memory flat under abuse.
const IP_MAX_PER_HOUR = Number(process.env.FAUCET_IP_MAX_PER_HOUR || "4");
const _ipHits = new Map<string, number[]>();
function ipAllowed(ip: string): boolean {
  const now = Date.now();
  const win = (_ipHits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (win.length >= IP_MAX_PER_HOUR) { _ipHits.set(ip, win); return false; }
  win.push(now); _ipHits.set(ip, win);
  if (_ipHits.size > 5000) for (const [k, v] of _ipHits) if (v.every((t) => now - t >= 3_600_000)) _ipHits.delete(k);
  return true;
}

/**
 * Dev faucet: tops a player's embedded wallet with a small, FIXED, server-capped amount of devnet
 * SOL so they can play. The amount is NOT caller-controlled, repeat funding to the same address is
 * blocked by the balance guard, total outflow is bounded by DAILY_CAP_LAMPORTS per process, and the
 * whole route can be disabled with FAUCET_ENABLED=0. In production, funding happens through the on-ramp.
 */
export async function POST(req: NextRequest) {
  try {
    if (!FAUCET_ENABLED) return NextResponse.json({ error: "faucet disabled" }, { status: 403 });
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
    if (!ipAllowed(ip)) return NextResponse.json({ error: "too many top-ups — try again later" }, { status: 429 });
    const { pubkey } = await req.json();
    const to = new PublicKey(pubkey); // throws on malformed input
    const now = Date.now();
    if (now - _windowStart > 86_400_000) { _windowStart = now; _spent = 0; }
    if (_spent + FAUCET_MAX_LAMPORTS > DAILY_CAP_LAMPORTS) return NextResponse.json({ error: "faucet daily cap reached" }, { status: 429 });
    const conn = new Connection(RPC, "confirmed");
    const bal = await conn.getBalance(to);
    if (bal > 0.06e9) return NextResponse.json({ funded: false, balanceSol: bal / 1e9, note: "already funded" });
    const kp = loadServerKeypair();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: FAUCET_MAX_LAMPORTS }));
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    _spent += FAUCET_MAX_LAMPORTS;
    return NextResponse.json({ funded: true, sig, sol: FAUCET_MAX_LAMPORTS / 1e9 });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
