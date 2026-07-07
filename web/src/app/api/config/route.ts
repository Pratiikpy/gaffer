import { NextResponse } from "next/server";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);
const MAX_RAKE_BPS = 500; // mirrors the kernel's hard cap
let cache: { at: number; v: any } | null = null;

/** The live commercial-floor state, read straight from the on-chain Config PDA: today's protocol rake
 * (0), the verifiable ceiling (5%), and that the cut only ever touches winnings. Powers the honest
 * "no house cut" fee line and the revenue screen — the number the app shows is the number on-chain. */
export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > 30_000) {
      const conn = new Connection(RPC, "confirmed");
      const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(Keypair.generate()), { commitment: "confirmed" }));
      const config = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
      const c: any = await program.account.config.fetch(config);
      cache = { at: Date.now(), v: { rakeBps: Number(c.rakeBps), maxRakeBps: MAX_RAKE_BPS, onWinningsOnly: true } };
    }
    return NextResponse.json(cache.v);
  } catch {
    // Never block the UI on this — fall back to the shipped default (0%, capped 5%).
    return NextResponse.json({ rakeBps: 0, maxRakeBps: MAX_RAKE_BPS, onWinningsOnly: true });
  }
}
