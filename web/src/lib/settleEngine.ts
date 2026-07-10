import "server-only";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "./latch.idl.json";
import { KeypairWallet } from "./wallet";
import { RPC, TXORACLE } from "./config";
import { loadServerKeypair } from "./serverConfig";
import { txline } from "./txline";
import { prettyErr } from "./errcopy";
import { recordSettle } from "./economy";
import { settleDuelsForMarket } from "./squadPlus";

/** The settlement engine.
 *
 * One code path, three callers: the manual `/api/settle` crank, the parlay crank, and the unattended
 * keeper that sweeps everything on a schedule. It lived inline in the routes before, which meant the
 * keeper would have been a *second* implementation of the most consequential logic in the product — the
 * bit that decides whether a fan gets paid. There is exactly one of it now.
 *
 * Nothing here decides an outcome. `settle` fires a CPI into TxLINE's `validate_stat`, which re-verifies
 * the Merkle proof against the oracle's anchored roots and returns a bool. A dishonest crank cannot
 * settle a market wrongly; the worst it can do is waste its own fee. That is why cranking is
 * permissionless and why the keeper is boring.
 */

export const PROGRAM_ID = new PublicKey((idl as any).address);
/** The keeper's head start to prove a rightful YES before NO may be settled. */
export const VOID_GRACE_SECS = 120;
/** How long before anyone may VOID. Long, because an early void would claw a pot back from a NO winner. */
export const RESOLVE_GRACE_SECS = 3600;

const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });

export function serverProgram(): any {
  const conn = new Connection(RPC, "confirmed");
  const kp = loadServerKeypair();
  return new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));
}

/* K5 — per-(fixture, statKey) proof cache. Discovering a proof costs one historicalEvents call plus up
 * to ten statValidation calls; every market on the same fixture and stat would otherwise repeat all of
 * it. An anchored proof does not change once found, so it is safe to hold. Misses are cached too, more
 * briefly, so a fixture with no proof yet doesn't get hammered by a keeper sweeping twenty markets. */
const HIT_TTL = 10 * 60_000;
const MISS_TTL = 20_000;
const proofCache = new Map<string, { at: number; bundle: any | null }>();

export async function findProof(fixtureId: number, statKey: number): Promise<any | null> {
  const key = `${fixtureId}:${statKey}`;
  const hit = proofCache.get(key);
  if (hit && Date.now() - hit.at < (hit.bundle ? HIT_TTL : MISS_TTL)) return hit.bundle;

  const events = await txline().historicalEvents(fixtureId);
  const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!seqs.length) { proofCache.set(key, { at: Date.now(), bundle: null }); return null; }
  const idxs = [...new Set(Array.from({ length: 10 }, (_, k) => Math.floor((seqs.length - 1) * (k / 9))))];
  let bundle: any = null;
  for (const i of idxs) { const b = await txline().statValidation(fixtureId, seqs[i], statKey); if (b) { bundle = b; break; } }
  proofCache.set(key, { at: Date.now(), bundle });
  return bundle;
}

/** Anchored-roots PDA for the day a proof's summary falls in. */
function dsrFor(seedTs: number): PublicKey {
  const epochDay = Math.floor(seedTs / 86400000);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];
}

const summaryOf = (b: any) => ({
  fixtureId: new BN(b.summary.fixtureId),
  updateStats: {
    updateCount: b.summary.updateStats.updateCount,
    minTimestamp: new BN(b.summary.updateStats.minTimestamp),
    maxTimestamp: new BN(b.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: b.summary.eventStatsSubTreeRoot,
});
const termOf = (b: any) => ({
  statToProve: { key: b.statToProve.key, value: b.statToProve.value, period: b.statToProve.period },
  eventStatRoot: b.eventStatRoot,
  statProof: b.statProof.map(node),
});

export type SettleResult = { settled: boolean; sig?: string; reason?: string; code?: string; provenValue?: number; outcome?: string };

/** Prove a market's predicate and settle it YES on-chain. */
export async function settleMarket(program: any, market: string): Promise<SettleResult> {
  const kp = loadServerKeypair();
  const marketPk = new PublicKey(market);
  const m: any = await program.account.market.fetch(marketPk);
  if (m.status !== 0) return { settled: false, reason: "not open" };

  const fixtureId = Number(m.fixtureId);
  const bundle = await findProof(fixtureId, m.statKey);
  if (!bundle) return { settled: false, reason: "no anchored proof yet" };

  const seedTs = Number(bundle.summary.updateStats.minTimestamp);
  try {
    const sig = await program.methods
      .settle(new BN(seedTs), summaryOf(bundle), bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), termOf(bundle), null, null)
      .accounts({ settler: kp.publicKey, market: marketPk, dailyScoresMerkleRoots: dsrFor(seedTs), txoracleProgram: TXORACLE })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();

    // A true predicate does not always mean a YES payout. If nobody was on YES the kernel voids and
    // refunds both sides (C3) rather than trapping the pot in an unclaimable state — so read the status
    // the chain actually wrote instead of assuming the happy path. Reporting "YES" on a voided market
    // would put a lie in the keeper's log, and would settle every Fade Duel on it the wrong way.
    const after: any = await program.account.market.fetch(marketPk);
    const paidYes = after.status === 1;

    if (paidYes) {
      // C1 — how fast we paid, measured from the proof's own last match timestamp (not a guess).
      const matchTs = Number(bundle.summary.updateStats.maxTimestamp) || 0;
      await recordSettle(market, fixtureId, matchTs, Math.max(0, Date.now() - matchTs)).catch(() => {});
      // S6 — every Fade Duel on this pool settles off the pool's own result.
      await settleDuelsForMarket(market, 1).catch(() => {});
    }
    return { settled: true, sig, provenValue: bundle.statToProve.value, outcome: paidYes ? "YES" : "VOID" };
  } catch (e: any) {
    return { settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" };
  }
}

/** Settle a market AGAINST its predicate: prove it never happened, and pay the NO side.
 *
 * The mirror of `settleMarket`. It needs a proof snapshot taken at or after the market's close — a proof
 * that Spain hadn't scored by minute three is true and worthless — so we sample the newest anchored
 * sequences first and take the first one whose summary timestamp clears `expiry_ts`.
 *
 * The kernel re-checks all of that. This only finds the evidence.
 */
export async function settleMarketNo(program: any, market: string): Promise<SettleResult> {
  const kp = loadServerKeypair();
  const marketPk = new PublicKey(market);
  const m: any = await program.account.market.fetch(marketPk);
  if (m.status !== 0) return { settled: false, reason: "not open" };

  const expiry = Number(m.expiryTs);
  const now = Math.floor(Date.now() / 1000);
  if (now < expiry + VOID_GRACE_SECS) return { settled: false, reason: "still open" };

  const fixtureId = Number(m.fixtureId);
  const bundle = await findProofAfter(fixtureId, m.statKey, expiry);
  if (!bundle) return { settled: false, reason: "no anchored proof from after the close yet" };

  const seedTs = Number(bundle.summary.updateStats.minTimestamp);
  try {
    const sig = await program.methods
      .settleNo(new BN(seedTs), summaryOf(bundle), bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), termOf(bundle))
      .accounts({ settler: kp.publicKey, market: marketPk, dailyScoresMerkleRoots: dsrFor(seedTs), txoracleProgram: TXORACLE })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();

    // Same honesty as the YES path: with nobody on NO the kernel voids and refunds instead of paying.
    const after: any = await program.account.market.fetch(marketPk);
    const paidNo = after.status === 3;
    if (paidNo) await settleDuelsForMarket(market, 2).catch(() => {});
    return { settled: true, sig, provenValue: bundle.statToProve.value, outcome: paidNo ? "NO" : "VOID" };
  } catch (e: any) {
    return { settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" };
  }
}

/** The newest anchored proof whose snapshot sits at or after `afterSecs`. Newest-first: the final
 *  whistle's snapshot is the one that settles a match, and it is the last thing anchored. */
async function findProofAfter(fixtureId: number, statKey: number, afterSecs: number): Promise<any | null> {
  const events = await txline().historicalEvents(fixtureId);
  const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!seqs.length) return null;
  const sample = [...new Set(Array.from({ length: 10 }, (_, k) => Math.floor((seqs.length - 1) * (k / 9))))].map((i) => seqs[i]);
  for (const s of sample) {
    const b = await txline().statValidation(fixtureId, s, statKey);
    if (b && Number(b.summary.updateStats.minTimestamp) / 1000 >= afterSecs) return b;
  }
  return null;
}

/** Refund a market whose predicate never came true. Only legal once `expiry + grace` has passed. */
export async function voidMarket(program: any, market: string): Promise<SettleResult> {
  const kp = loadServerKeypair();
  const marketPk = new PublicKey(market);
  const m: any = await program.account.market.fetch(marketPk);
  if (m.status !== 0) return { settled: false, reason: "not open" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(m.expiryTs) + RESOLVE_GRACE_SECS) return { settled: false, reason: "not expired" };
  try {
    const sig = await program.methods.void().accounts({ cranker: kp.publicKey, market: marketPk }).rpc();
    return { settled: true, sig, outcome: "VOID" };
  } catch (e: any) {
    return { settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" };
  }
}

/** Prove every open leg; the kernel flips the parlay to YES once the last one lands. Past expiry+grace
 * without a full sweep, resolve it — NO if anyone faded it, VOID (refund) if nobody did. */
export async function settleParlay(program: any, parlay: string): Promise<SettleResult & { legsHit?: number; proven?: number[] }> {
  const kp = loadServerKeypair();
  const pk = new PublicKey(parlay);
  let p: any = await program.account.parlay.fetch(pk);
  if (p.status !== 0) return { settled: false, reason: "not open" };

  const fixtureId = Number(p.fixtureId);
  const events = await txline().historicalEvents(fixtureId);
  const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
  const sample = [...new Set(Array.from({ length: 12 }, (_, k) => Math.floor((seqs.length - 1) * (k / 11))))]
    .map((i) => seqs[i]).filter((s) => Number.isFinite(s));

  const proven: number[] = [];
  for (let i = 0; i < p.legs.length; i++) {
    const leg = p.legs[i];
    if (leg.hit) continue;
    // A leg needs a seq where its stat is anchored AND clears the threshold (the predicate is true).
    let bundle: any = null;
    for (const s of sample) {
      const bb = await txline().statValidation(fixtureId, s, leg.statKey);
      if (bb && bb.statToProve.value > leg.threshold) { bundle = bb; break; }
    }
    if (!bundle) continue;
    const seedTs = Number(bundle.summary.updateStats.minTimestamp);
    try {
      await program.methods
        .settleLeg(i, new BN(seedTs), summaryOf(bundle), bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), termOf(bundle), null, null)
        .accounts({ settler: kp.publicKey, parlay: pk, dailyScoresMerkleRoots: dsrFor(seedTs), txoracleProgram: TXORACLE })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
      proven.push(i);
    } catch { /* leg not provable yet; leave it open */ }
  }

  p = await program.account.parlay.fetch(pk);
  if (p.status === 1) return { settled: true, outcome: "YES", legsHit: p.legsHit, proven };

  const now = Math.floor(Date.now() / 1000);
  if (now >= Number(p.expiryTs) + VOID_GRACE_SECS) {
    try {
      const sig = await program.methods.resolveParlay().accounts({ cranker: kp.publicKey, parlay: pk }).rpc();
      const after: any = await program.account.parlay.fetch(pk); // 3 = NO wins, 2 = void (nobody faded)
      return { settled: true, outcome: after.status === 3 ? "NO" : "VOID", sig };
    } catch (e: any) {
      return { settled: false, reason: prettyErr(e, "neutral"), code: e.error?.errorCode?.code || "" };
    }
  }
  return { settled: false, reason: `legs hit ${p.legsHit}/${p.legs.length}; awaiting more proofs`, proven };
}
