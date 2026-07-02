/** CRANK settlement keeper — unattended: for each open market, discover a valid anchored
 * proof from the TxLINE feed and fire settle. The keeper picks nothing about the outcome;
 * validate_stat (inside the kernel CPI) decides. Deterministic, no LLM, idempotent. */
import { PublicKey } from "@solana/web3.js";
import { Kernel } from "./kernel";
import { TxlineClient } from "./txline";

export class Keeper {
  constructor(private kernel: Kernel, private tx: TxlineClient) {}

  /** Find a (seq, anchored proof bundle) for a fixture+statKey — tries a spread of seqs. */
  async findProof(fixtureId: number, statKey: number): Promise<{ seq: number; bundle: any } | null> {
    const events = await this.tx.historicalEvents(fixtureId);
    const seqs = [...new Set(events.map((e) => Number(e.seq ?? e.Seq)).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a);
    if (!seqs.length) return null;
    // sample 10 seqs across the match (newest first — most likely already anchored)
    const idxs = [...new Set(Array.from({ length: 10 }, (_, k) => Math.floor((seqs.length - 1) * (k / 9))))];
    for (const i of idxs) {
      const seq = seqs[i];
      const bundle = await this.tx.statValidation(fixtureId, seq, statKey);
      if (bundle) return { seq, bundle };
    }
    return null;
  }

  /** Attempt to settle one market. Returns a result record (no throw on PredicateNotMet). */
  async settleMarket(marketPubkey: PublicKey) {
    const m: any = await this.kernel.fetchMarket(marketPubkey);
    if (m.status !== 0) return { settled: false, reason: "not open" };
    const fixtureId = typeof m.fixtureId?.toNumber === "function" ? m.fixtureId.toNumber() : Number(m.fixtureId);
    const found = await this.findProof(fixtureId, m.statKey);
    if (!found) return { settled: false, reason: "no anchored proof yet" };
    try {
      const sig = await this.kernel.settle(marketPubkey, found.bundle);
      return { settled: true, sig, seq: found.seq, provenValue: found.bundle.statToProve.value };
    } catch (e: any) {
      return { settled: false, reason: e.error?.errorCode?.code || (e.message || "").slice(0, 60) };
    }
  }

  async runOnce() {
    const open = await this.kernel.listOpenMarkets();
    const out: any[] = [];
    for (const m of open) out.push({ market: m.publicKey.toBase58(), ...(await this.settleMarket(m.publicKey)) });
    return out;
  }

  /** Run unattended until no open markets remain (or maxIters reached). */
  async runLoop(intervalMs = 8000, maxIters = 8) {
    for (let i = 0; i < maxIters; i++) {
      const r = await this.runOnce();
      console.log(`  [keeper tick ${i}] ` + (r.length ? r.map((x) => `${x.market.slice(0, 6)}…: ${x.settled ? "SETTLED seq " + x.seq + " (val " + x.provenValue + ") " + x.sig.slice(0, 8) : x.reason}`).join("  |  ") : "no open markets"));
      const left = await this.kernel.listOpenMarkets();
      if (!left.length) return;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
}
