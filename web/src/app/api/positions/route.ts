import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC } from "@/lib/config";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One fan's open calls, coalesced per owner.
 *
 * Display only — every collect re-reads the position straight from the chain before it moves a lamport,
 * so a slightly stale list here can never pay the wrong person. What it buys is a room's worth of phones
 * (and one fan's three open tabs) sharing a single `getProgramAccounts` instead of each starting their
 * own every fifteen seconds.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner") || "";
  let ownerPk: PublicKey;
  try { ownerPk = new PublicKey(owner); } catch { return NextResponse.json({ error: "bad owner" }, { status: 400 }); }

  try {
    const positions = await cached(`positions:${owner}`, { ttlMs: 3000, swrMs: 30_000, staleMs: 60_000 }, async () => {
      const conn = new Connection(RPC, "confirmed");
      const provider = new AnchorProvider(conn, new KeypairWallet(Keypair.generate()), { commitment: "confirmed" });
      const program: any = new Program(idl as any, provider);
      // offset 40 = the position's `owner` field (8 discriminator + 32 market).
      const rows = await program.account.position.all([{ memcmp: { offset: 40, bytes: ownerPk.toBase58() } }]);
      return rows.map((r: any) => ({
        market: r.account.market.toBase58(),
        side: r.account.side,
        amount: Number(r.account.amount) / 1e9,
        claimed: r.account.claimed,
      }));
    });
    return NextResponse.json({ positions });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
