import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC, TXORACLE } from "@/lib/config";
import { loadServerKeypair } from "@/lib/serverConfig";
import { txline } from "@/lib/txline";
import { prettyErr } from "@/lib/errcopy";
import { recordSettle } from "@/lib/economy";
import { settleDuelsForMarket } from "@/lib/squadPlus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });

// Settlement is permissionless on-chain — the kernel re-verifies the TxLINE Merkle proof against the
// oracle's anchored roots, so a bad crank can't settle a market wrongly. Anyone may crank; this route
// just fronts the fee with the server keypair. A light per-IP throttle keeps that fee-spend bounded.
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now(), win = hits.get(ip)?.filter((t) => now - t < 60_000) ?? [];
  if (win.length >= 8) { hits.set(ip, win); return true; }
  win.push(now); hits.set(ip, win); return false;
}

/** Permissionless keeper crank: discover an anchored proof for a market and settle it on-chain. */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (throttled(ip)) return NextResponse.json({ settled: false, reason: "Easy — one collect at a time." }, { status: 429 });
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
      // C1 — how fast we paid, measured from the proof's own last match timestamp (not a guess).
      const matchTs = Number(bundle.summary.updateStats.maxTimestamp) || 0;
      await recordSettle(market, fixtureId, matchTs, Math.max(0, Date.now() - matchTs)).catch(() => {});
      // S6 — every Fade Duel on this pool settles off the pool's own result. `settle` only ever
      // resolves YES (a predicate that held), so YES (side 1) takes the duel.
      await settleDuelsForMarket(market, 1).catch(() => {});
      return NextResponse.json({ settled: true, sig, provenValue: bundle.statToProve.value });
    } catch (e: any) {
      return NextResponse.json({ settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" });
    }
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
