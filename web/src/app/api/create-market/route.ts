import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC } from "@/lib/config";
import { loadServerKeypair, adminOk } from "@/lib/serverConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);

/** Admin/keeper route: opens a market signed + rent-funded by the server keypair. Guarded by adminOk. */
export async function POST(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json();
    const fixtureId = Number(b.fixtureId);
    const statKey = Number(b.statKey ?? 1);
    const period = Number(b.period ?? 4);
    const threshold = Number(b.threshold ?? 0);
    const comparison = Number(b.comparison ?? 0);
    // v1 kernel only accepts GreaterThan (monotone over-threshold); reject early with a clear message.
    if (!Number.isFinite(fixtureId) || !Number.isFinite(statKey) || comparison !== 0) {
      return NextResponse.json({ error: "invalid params (v1 markets are GreaterThan only)" }, { status: 400 });
    }
    const expirySecs = Number(b.expirySecs ?? Math.floor(Date.now() / 1000) + 7 * 86400);
    // lock_ts is the cut-off for new calls (KILL-1). Flash pools pass a short one; if omitted the
    // market stays joinable until expiry (no earlier lock than the settlement window).
    const lockSecs = Number(b.lockSecs ?? expirySecs);
    if (!Number.isFinite(expirySecs) || !Number.isFinite(lockSecs) || lockSecs > expirySecs) {
      return NextResponse.json({ error: "lock must be finite and no later than expiry" }, { status: 400 });
    }

    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    // Defense-in-depth: even behind adminOk, never mint the wallet below a floor — if the admin key ever
    // leaked, an unbounded mint spam would otherwise drain the wallet that also settles pools.
    if ((await conn.getBalance(kp.publicKey)) / 1e9 < 0.3) return NextResponse.json({ error: "below server SOL floor" }, { status: 503 });
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));

    const id = new BN(Date.now()).mul(new BN(1000)).add(new BN(Math.floor(Math.random() * 1000))); // ms + entropy → no same-ms PDA collision
    const market = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
    const sig = await program.methods.createMarket(id, new BN(fixtureId), statKey, period, threshold, comparison, new BN(lockSecs), new BN(expirySecs))
      .accounts({ authority: kp.publicKey, market, vault, systemProgram: SystemProgram.programId }).rpc();

    return NextResponse.json({ market: market.toBase58(), marketId: id.toString(), sig });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
