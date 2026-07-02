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

/** Keeper crank for a parlay: prove every still-open leg from anchored data; once all legs hit it
 * settles YES, and if it's past expiry+grace without all legs hitting, resolve it to NO. */
export async function POST(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { parlay } = await req.json();
    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));
    const pk = new PublicKey(parlay);
    let p: any = await program.account.parlay.fetch(pk);
    if (p.status !== 0) return NextResponse.json({ settled: false, reason: "not open" });

    const fixtureId = Number(p.fixtureId);
    const events = await txline().historicalEvents(fixtureId);
    const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
    const sample = [...new Set(Array.from({ length: 12 }, (_, k) => Math.floor((seqs.length - 1) * (k / 11))))].map((i) => seqs[i]).filter((s) => Number.isFinite(s));

    const proven: number[] = [];
    for (let i = 0; i < p.legs.length; i++) {
      const leg = p.legs[i];
      if (leg.hit) continue;
      // find a seq where this leg's stat is anchored AND clears the threshold (predicate true)
      let bundle: any = null;
      for (const s of sample) { const bb = await txline().statValidation(fixtureId, s, leg.statKey); if (bb && bb.statToProve.value > leg.threshold) { bundle = bb; break; } }
      if (!bundle) continue;
      const seedTs = Number(bundle.summary.updateStats.minTimestamp);
      const dsr = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(Math.floor(seedTs / 86400000)).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];
      const fixtureSummary = {
        fixtureId: new BN(bundle.summary.fixtureId),
        updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
        eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
      };
      const statA = { statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) };
      try {
        await program.methods.settleLeg(i, new BN(seedTs), fixtureSummary, bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), statA, null, null)
          .accounts({ settler: kp.publicKey, parlay: pk, dailyScoresMerkleRoots: dsr, txoracleProgram: TXORACLE })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
        proven.push(i);
      } catch { /* leg not provable yet; leave open */ }
    }

    p = await program.account.parlay.fetch(pk);
    if (p.status === 1) return NextResponse.json({ settled: true, outcome: "YES", legsHit: p.legsHit, proven });

    // not all legs hit — if past expiry + grace, resolve to NO (bust)
    const now = Math.floor(Date.now() / 1000);
    if (now >= Number(p.expiryTs) + 120) {
      try {
        const sig = await program.methods.resolveParlay().accounts({ cranker: kp.publicKey, parlay: pk }).rpc();
        const after: any = await program.account.parlay.fetch(pk); // 3 = NO wins, 2 = void (nobody faded → refund)
        return NextResponse.json({ settled: true, outcome: after.status === 3 ? "NO" : "VOID", sig });
      } catch (e: any) { return NextResponse.json({ settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" }); }
    }
    return NextResponse.json({ settled: false, reason: `legs hit ${p.legsHit}/${p.legs.length}; awaiting more proofs`, proven });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
