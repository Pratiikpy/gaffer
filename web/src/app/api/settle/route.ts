import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC, TXORACLE } from "@/lib/config";
import { loadServerKeypair, adminOk } from "@/lib/serverConfig";
import { txline } from "@/lib/txline";
import { prettyErr } from "@/lib/errcopy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });

/** Keeper crank: discover an anchored proof for a market and settle it. Guarded by adminOk
 * (settle is also permissionless on-chain, but this route spends the server keypair's fees). */
export async function POST(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { market } = await req.json();
    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));
    const marketPk = new PublicKey(market);
    const m: any = await program.account.market.fetch(marketPk);
    if (m.status !== 0) return NextResponse.json({ settled: false, reason: "not open" });

    const fixtureId = Number(m.fixtureId);
    const events = await txline().historicalEvents(fixtureId);
    const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
    const idxs = [...new Set(Array.from({ length: 10 }, (_, k) => Math.floor((seqs.length - 1) * (k / 9))))];
    let bundle: any = null;
    for (const i of idxs) { const b = await txline().statValidation(fixtureId, seqs[i], m.statKey); if (b) { bundle = b; break; } }
    if (!bundle) return NextResponse.json({ settled: false, reason: "no anchored proof yet" });

    const seedTs = Number(bundle.summary.updateStats.minTimestamp);
    const epochDay = Math.floor(seedTs / 86400000);
    const dsr = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];
    const fixtureSummary = {
      fixtureId: new BN(bundle.summary.fixtureId),
      updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
      eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
    };
    const statA = { statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) };
    try {
      const sig = await program.methods.settle(new BN(seedTs), fixtureSummary, bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), statA, null, null)
        .accounts({ settler: kp.publicKey, market: marketPk, dailyScoresMerkleRoots: dsr, txoracleProgram: TXORACLE })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
      return NextResponse.json({ settled: true, sig, provenValue: bundle.statToProve.value });
    } catch (e: any) {
      return NextResponse.json({ settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" });
    }
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
