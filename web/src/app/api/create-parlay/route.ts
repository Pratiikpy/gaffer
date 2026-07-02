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

/** Admin route: open a parlay (the multi-call slip) over N stat predicates within ONE fixture.
 * The kernel binds every leg to this fixture and is all-or-nothing (Power). Guarded by adminOk. */
export async function POST(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json();
    const fixtureId = Number(b.fixtureId);
    const legs = Array.isArray(b.legs) ? b.legs : [];
    if (!Number.isFinite(fixtureId) || legs.length < 1 || legs.length > 8) {
      return NextResponse.json({ error: "1–8 legs required, all in one fixture" }, { status: 400 });
    }
    const cleanLegs = legs.map((l: any) => ({
      statKey: Number(l.statKey), period: Number(l.period ?? 0), threshold: Number(l.threshold ?? 0), comparison: Number(l.comparison ?? 0),
    }));
    if (cleanLegs.some((l: any) => l.comparison !== 0 || ![l.statKey, l.period, l.threshold].every((x: number) => Number.isFinite(x)))) {
      return NextResponse.json({ error: "legs must be GreaterThan (v1) with finite stat key / period / threshold" }, { status: 400 });
    }
    const expirySecs = Number(b.expirySecs ?? Math.floor(Date.now() / 1000) + 7 * 86400);
    const lockSecs = Number(b.lockSecs ?? expirySecs); // cut-off for new calls (KILL-1); defaults to expiry
    if (!Number.isFinite(expirySecs) || !Number.isFinite(lockSecs) || lockSecs > expirySecs) {
      return NextResponse.json({ error: "lock must be finite and no later than expiry" }, { status: 400 });
    }

    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));
    const id = new BN(Date.now()).mul(new BN(1000)).add(new BN(Math.floor(Math.random() * 1000))); // ms + entropy → no same-ms PDA collision
    const parlay = PublicKey.findProgramAddressSync([Buffer.from("parlay"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from("pvault"), parlay.toBuffer()], PROGRAM_ID)[0];
    const sig = await program.methods.createParlay(id, new BN(fixtureId), cleanLegs, new BN(lockSecs), new BN(expirySecs))
      .accounts({ authority: kp.publicKey, parlay, vault, systemProgram: SystemProgram.programId }).rpc();

    return NextResponse.json({ parlay: parlay.toBase58(), parlayId: id.toString(), sig });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
