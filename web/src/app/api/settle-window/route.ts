import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC, TXORACLE } from "@/lib/config";
import { loadServerKeypair } from "@/lib/serverConfig";
import { txline } from "@/lib/txline";
import { prettyErr } from "@/lib/errcopy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const summaryOf = (b: any) => ({
  fixtureId: new BN(b.summary.fixtureId),
  updateStats: { updateCount: b.summary.updateStats.updateCount, minTimestamp: new BN(b.summary.updateStats.minTimestamp), maxTimestamp: new BN(b.summary.updateStats.maxTimestamp) },
  eventsSubTreeRoot: b.summary.eventStatsSubTreeRoot,
});
const termOf = (b: any) => ({
  statToProve: { key: b.statToProve.key, value: b.statToProve.value, period: b.statToProve.period },
  eventStatRoot: b.eventStatRoot,
  statProof: b.statProof.map(node),
});

/** K2 — the window crank.
 *
 * A window market asks whether a stat MOVED by `delta` between the window opening and expiry. The kernel
 * cannot read a value out of `validate_stat` (it returns a bool), so this finds two anchored snapshots —
 * one at or after the window opened, one later — and lets the kernel prove the move across them:
 *
 *     value(t_a) <= baseline  and  value(t_b) >= baseline + delta   ⇒   the move happened.
 *
 * We take `baseline` to be the earlier snapshot's own value, which is the tightest honest choice, and
 * then look for any later snapshot that clears it. The kernel re-proves both against the anchored roots,
 * so nothing here is taken on trust — this route only finds the evidence, it never asserts the verdict.
 */
export async function POST(req: NextRequest) {
  try {
    const { market } = await req.json();
    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));

    const marketPk = new PublicKey(market);
    const m: any = await program.account.market.fetch(marketPk);
    if (m.status !== 0) return NextResponse.json({ settled: false, reason: "not open" });

    const windowPk = PublicKey.findProgramAddressSync([Buffer.from("window"), marketPk.toBuffer()], PROGRAM_ID)[0];
    const w: any = await program.account.marketWindow.fetch(windowPk).catch(() => null);
    if (!w) return NextResponse.json({ settled: false, reason: "that market has no window" });

    const fixtureId = Number(m.fixtureId);
    const startTs = Number(w.startTs), delta = Number(w.delta), expiry = Number(m.expiryTs);

    const events = await txline().historicalEvents(fixtureId);
    const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => a - b);
    if (!seqs.length) return NextResponse.json({ settled: false, reason: "no events yet" });

    // Sample across the match, oldest first: the first usable snapshot inside the window is the baseline.
    const sample = [...new Set(Array.from({ length: 16 }, (_, k) => Math.floor((seqs.length - 1) * (k / 15))))].map((i) => seqs[i]);

    let a: any = null, b: any = null, baseline = 0;
    for (const s of sample) {
      const bundle = await txline().statValidation(fixtureId, s, m.statKey);
      if (!bundle) continue;
      const ts = Number(bundle.summary.updateStats.minTimestamp);
      const value = Number(bundle.statToProve.value);
      if (ts / 1000 < startTs) continue;              // predates the window
      if (ts / 1000 > expiry) break;                  // past expiry
      if (!a) { a = { bundle, ts, value }; baseline = value; continue; }
      if (value >= baseline + delta && ts >= a.ts) { b = { bundle, ts, value }; break; }
    }
    if (!a) return NextResponse.json({ settled: false, reason: "no anchored snapshot inside the window yet" });
    if (!b) return NextResponse.json({ settled: false, reason: `nothing moved by ${delta} inside the window yet`, baseline, sawValue: a.value });

    const dsrOf = (ts: number) => PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(Math.floor(ts / 86400000)).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];
    // Both proofs must resolve against the same roots account; they do when both fall on the same day.
    const dsr = dsrOf(a.ts);

    try {
      // Two proofs cannot share one transaction, so bank the baseline first, then settle with the
      // second proof. Both are re-verified on-chain against the anchored roots.
      const sigA = await program.methods.proveWindowBaseline(
        baseline, new BN(a.ts), summaryOf(a.bundle), a.bundle.subTreeProof.map(node), a.bundle.mainTreeProof.map(node), termOf(a.bundle),
      )
        .accounts({ settler: kp.publicKey, market: marketPk, window: windowPk, dailyScoresMerkleRoots: dsr, txoracleProgram: TXORACLE })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })]).rpc();

      const sig = await program.methods.settleWindow(
        new BN(b.ts), summaryOf(b.bundle), b.bundle.subTreeProof.map(node), b.bundle.mainTreeProof.map(node), termOf(b.bundle),
      )
        .accounts({ settler: kp.publicKey, market: marketPk, window: windowPk, dailyScoresMerkleRoots: dsr, txoracleProgram: TXORACLE })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })]).rpc();

      return NextResponse.json({ settled: true, baselineSig: sigA, sig, baseline, delta, from: a.value, to: b.value });
    } catch (e: any) {
      return NextResponse.json({ settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "", raw: String(e?.message || e).slice(0, 220), logs: (e.logs || []).slice(-6) });
    }
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 160) }, { status: 500 });
  }
}
