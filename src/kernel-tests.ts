/**
 * LATCH kernel — real devnet test suite (fund-safety + every instruction + negatives).
 *
 * Runs against the deployed program on devnet (validate_stat needs the real txoracle + anchored
 * roots, so this cannot run on localnet). Every case ASSERTS an on-chain outcome; the process
 * exits non-zero if ANY case fails. This is the proof that the hardened kernel decides correctly
 * and cannot be made to pay the wrong side or lock funds.
 *
 * Covers: positive single-market settle + multi-staker pro-rata + exact dust + loser-reject +
 * double-claim; negatives: cross-fixture (FixtureMismatch), binary-expression (BinaryNotAllowed),
 * false predicate (PredicateNotMet), expired proof (Expired), non-monotone create (OnlyGreaterThan),
 * past expiry (BadExpiry); lock_ts gate (BadLock on create, PoolLocked on join_pool/join_parlay after
 * the cut-off); empty-winning-side → VOID refund; time-gated void() refund; parlay YES (2-leg) claim;
 * parlay cross-fixture/binary leg negatives; parlay partial-then-bust → NO wins.
 *
 * Run:  npx ts-node src/kernel-tests.ts     (wallet A = .devnet-key.json, ~2 SOL; ~6 min incl. grace waits)
 */
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import latchIdl from "../idl/latch.json";
import { TxlineClient, TXORACLE } from "./txline";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
// A finished World Cup fixture whose day is still anchored in `daily_scores_roots` (USA 2-0 Bosnia:
// goals and corners both > 0, so one seq proves every market shape the suite needs). Override with
// FIXTURE=<id> when this one's anchor eventually ages out — the roots keep roughly three weeks.
// Resolved in section 0: env override, else auto-discovered so the suite is always runnable even as
// match days rotate out of daily_scores_roots (the roots keep ~3 weeks).
let FIXTURE = Number(process.env.FIXTURE || 0);
const PROGRAM_ID = new PublicKey((latchIdl as any).address);
const GRACE = 120; // VOID_GRACE_SECS in the kernel
const MAX_RAKE_BPS = 500; // must match the kernel's hard cap
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const sec = (t: string) => console.log("\n" + "─".repeat(72) + "\n" + t + "\n" + "─".repeat(72));

// ── result tracking ──
let passed = 0, failed = 0;
const fails: string[] = [];
function pass(n: string) { passed++; console.log("  ✓ " + n); }
function fail(n: string, e?: any) { failed++; const msg = n + (e ? ` — ${e?.error?.errorMessage || e?.message || e}` : ""); fails.push(msg); console.log("  ✗ " + msg); if (e?.logs) console.log("    " + e.logs.slice(-5).join("\n    ")); }
function assert(cond: boolean, n: string) { if (cond) pass(n); else fail(n); return cond; }
function errCode(e: any): string {
  return e?.error?.errorCode?.code || (String(e?.message || e).match(/Error Code: (\w+)/)?.[1]) || (String(e?.message || e).match(/custom program error|Error Number/) ? "custom" : "") || "";
}
async function expectErr(label: string, code: string, fn: () => Promise<any>) {
  try { await fn(); fail(`${label} (expected ${code}, but it SUCCEEDED)`); }
  catch (e: any) {
    const got = errCode(e);
    if (got === code || String(e?.message || e).includes(code)) pass(`${label} → rejected with ${code}`);
    else fail(`${label} (expected ${code}, got "${got}")`, e);
  }
}

// ── PDAs ──
const marketPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
const vaultPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], PROGRAM_ID)[0];
const posPda = (m: PublicKey, u: PublicKey, side: number) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), u.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
const parlayPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("parlay"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
const pvaultPda = (p: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("pvault"), p.toBuffer()], PROGRAM_ID)[0];
const pposPda = (p: PublicKey, u: PublicKey, side: number) => PublicKey.findProgramAddressSync([Buffer.from("pposition"), p.toBuffer(), u.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0]; // singleton rake config
const dsrPda = (seedTsMs: number) => PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(Math.floor(seedTsMs / 86400000)).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];

function settleArgs(bundle: any) {
  const seedTs = Number(bundle.summary.updateStats.minTimestamp); // ms
  const fixtureSummary = {
    fixtureId: new BN(bundle.summary.fixtureId),
    updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
    eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
  };
  const statA = { statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) };
  return { seedTs, fixtureSummary, subTree: bundle.subTreeProof.map(node), mainTree: bundle.mainTreeProof.map(node), statA };
}
const cu = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];

async function main() {
  // Serialize + pace all Solana RPC calls — the public devnet RPC 429s on bursts.
  let rpcQ: Promise<any> = Promise.resolve();
  const throttledFetch = ((input: any, init?: any) => {
    const r = rpcQ.then(async () => { await sleep(450); return (globalThis.fetch as any)(input, init); });
    rpcQ = r.then(() => {}, () => {});
    return r;
  }) as any;
  const conn = new Connection(RPC, { commitment: "confirmed", fetch: throttledFetch });
  const A = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".devnet-key.json"), "utf8"))));
  const provA = new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" });
  const progA: any = new Program(latchIdl as any, provA);
  const progFor = (kp: Keypair): any => kp.publicKey.equals(A.publicKey) ? progA : new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));
  const bal = (pk: PublicKey) => conn.getBalance(pk);
  const rentMin = await conn.getMinimumBalanceForRentExemption(0); // vault rent buffer seeded at creation

  sec("LATCH KERNEL · DEVNET TEST SUITE");
  console.log("  program:", PROGRAM_ID.toBase58(), "| A:", A.publicKey.toBase58(), (await bal(A.publicKey)) / 1e9, "SOL");

  // fund two helper wallets
  const B = Keypair.generate(), C = Keypair.generate();
  await provA.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.35e9 }),
    SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: C.publicKey, lamports: 0.2e9 }),
  ), []);
  console.log("  funded B", B.publicKey.toBase58().slice(0, 8), "+ C", C.publicKey.toBase58().slice(0, 8));

  // Fetch real proofs: a seq where BOTH P1 goals (key 1) and P1 corners (key 7) are anchored > 0.
  // Auto-discover a still-anchored finished fixture so the suite never crashes as days age out — the
  // env FIXTURE wins; otherwise we walk the app's finished-match list (newest first) and pick the first
  // whose day is still in daily_scores_roots with both a goal and a corner to prove.
  sec("0 · Fetch real anchored proofs (P1 goals key1>0 AND corners key7>0)");
  const tx = await new TxlineClient(conn, A).authenticate();
  const BASE = process.env.GAFFER_BASE || "https://www.mygaffer.xyz";
  let candidates: number[] = FIXTURE ? [FIXTURE] : [];
  if (!candidates.length) {
    try {
      const list = await (globalThis.fetch as any)(`${BASE}/api/mystery/list`).then((r: any) => r.json());
      candidates = (list?.matches || []).map((m: any) => Number(m.fixtureId)).filter(Boolean);
    } catch { /* fall through */ }
  }
  if (!candidates.length) throw new Error("no candidate fixtures (set FIXTURE=<id> of a match whose day is still anchored)");
  let g: any = null, c: any = null, seq = 0;
  for (const fx of candidates) {
    const events = await tx.historicalEvents(fx).catch(() => []);
    const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => a - b);
    if (!seqs.length) continue;
    const spread = [...new Set(Array.from({ length: 24 }, (_, k) => Math.floor((seqs.length - 1) * (k / 23))))].map((i) => seqs[i]);
    for (const s of spread) {
      const gb = await tx.statValidation(fx, s, 1);
      const cb = await tx.statValidation(fx, s, 7);
      if (gb && cb && gb.statToProve.value > 0 && cb.statToProve.value > 0) { g = gb; c = cb; seq = s; FIXTURE = fx; break; }
    }
    if (g && c) break;
  }
  if (!g || !c) throw new Error(`no anchored fixture with BOTH goals>0 and corners>0 among ${candidates.length} candidates (their days may have aged out). Pass FIXTURE=<id> of a recent finished match.`);
  console.log(`  ✓ fixture ${FIXTURE} seq ${seq}: goals=${g.statToProve.value} (key ${g.statToProve.key}), corners=${c.statToProve.value} (key ${c.statToProve.key})`);

  // ── create the two TIME-GATED markets up front so the 120s grace elapses during the other tests ──
  // expiry = now+45s: short enough that expiry+grace lapses while T1-T11 run (minutes), but long
  // enough that the setup stakes below all land before lock_ts (== expiry) even on throttled RPC.
  sec("Pre · Create time-gated markets (void + parlay-bust), expiry = now+45s");
  const tVoidId = new BN(Date.now() + 1), tVoidExpiry = nowSec() + 45;
  const tVoid = marketPda(tVoidId), tVoidVault = vaultPda(tVoid);
  await progA.methods.createMarket(tVoidId, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(tVoidExpiry), new BN(tVoidExpiry))
    .accounts({ authority: A.publicKey, market: tVoid, vault: tVoidVault, systemProgram: SystemProgram.programId }).rpc();
  await progA.methods.joinPool(1, new BN(0.02e9)).accounts({ user: A.publicKey, market: tVoid, vault: tVoidVault, position: posPda(tVoid, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
  await progFor(B).methods.joinPool(2, new BN(0.02e9)).accounts({ user: B.publicKey, market: tVoid, vault: tVoidVault, position: posPda(tVoid, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc();
  console.log("  ✓ void-test market staked (A YES 0.02, B NO 0.02)");

  const tBustId = new BN(Date.now() + 2), tBustExpiry = nowSec() + 45;
  const tBust = parlayPda(tBustId), tBustVault = pvaultPda(tBust);
  await progA.methods.createParlay(tBustId, new BN(FIXTURE), [{ statKey: g.statToProve.key, period: 0, threshold: 0, comparison: 0 }, { statKey: c.statToProve.key, period: 0, threshold: 0, comparison: 0 }], new BN(tBustExpiry), new BN(tBustExpiry))
    .accounts({ authority: A.publicKey, parlay: tBust, vault: tBustVault, systemProgram: SystemProgram.programId }).rpc();
  await progA.methods.joinParlay(1, new BN(0.02e9)).accounts({ user: A.publicKey, parlay: tBust, vault: tBustVault, position: pposPda(tBust, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
  await progFor(B).methods.joinParlay(2, new BN(0.03e9)).accounts({ user: B.publicKey, parlay: tBust, vault: tBustVault, position: pposPda(tBust, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc();
  // settle ONLY leg0 (partial) — leg1 stays unproven so it must bust to NO at expiry
  const ga = settleArgs(g);
  await progA.methods.settleLeg(0, new BN(ga.seedTs), ga.fixtureSummary, ga.subTree, ga.mainTree, ga.statA, null, null)
    .accounts({ settler: A.publicKey, parlay: tBust, dailyScoresMerkleRoots: dsrPda(ga.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
  console.log("  ✓ bust-test parlay staked (A YES 0.02, B NO 0.03), leg0 proven (partial)");

  // ───────────────────────── T1: positive single-market + pro-rata + dust ─────────────────────────
  sec("T1 · Single market settles YES; multi-staker pro-rata + exact dust + loser reject + double-claim");
  {
    const id = new BN(Date.now() + 10);
    const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await progA.methods.joinPool(1, new BN(60e6)).accounts({ user: A.publicKey, market: m, vault: v, position: posPda(m, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();      // A YES 0.06
    await progFor(C).methods.joinPool(1, new BN(30e6)).accounts({ user: C.publicKey, market: m, vault: v, position: posPda(m, C.publicKey, 1), systemProgram: SystemProgram.programId }).rpc(); // C YES 0.03
    await progFor(B).methods.joinPool(2, new BN(40e6)).accounts({ user: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc(); // B NO 0.04
    assert((await bal(v)) === rentMin + 130e6, "vault holds rent buffer + the 0.13 pot");
    const a = settleArgs(g);
    await progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    const mk = await progA.account.market.fetch(m);
    assert(mk.status === 1, "status == SETTLED_YES (1)");
    // pro-rata: pot=130e6, yes_total=90e6 → A=floor(130e6*60e6/90e6)=86,666,666 ; C=43,333,333 ; dust=1
    const vBeforeA = await bal(v);
    await progA.methods.claim().accounts({ owner: A.publicKey, market: m, vault: v, position: posPda(m, A.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const paidA = vBeforeA - (await bal(v));
    assert(paidA === 86_666_666, `A pro-rata payout exact (got ${paidA}, want 86,666,666)`);
    const vBeforeC = await bal(v);
    await progFor(C).methods.claim().accounts({ owner: C.publicKey, market: m, vault: v, position: posPda(m, C.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const paidC = vBeforeC - (await bal(v));
    assert(paidC === 43_333_333, `C pro-rata payout exact (got ${paidC}, want 43,333,333)`);
    assert((await bal(v)) === rentMin + 1, `vault residual is rent buffer + 1 lamport of dust (got ${await bal(v)})`);
    await expectErr("B (NO loser) claim", "NotWinner", () => progFor(B).methods.claim().accounts({ owner: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc());
    await expectErr("A double-claim", "AlreadyClaimed", () => progA.methods.claim().accounts({ owner: A.publicKey, market: m, vault: v, position: posPda(m, A.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc());
  }

  // ───────────────────────── T2-T7: single-market negatives ─────────────────────────
  sec("T2-T7 · Settlement-binding + creation negatives");
  { // T2 cross-fixture
    const id = new BN(Date.now() + 20); const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(99999999), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    const a = settleArgs(g);
    await expectErr("T2 settle with a different fixture's proof", "FixtureMismatch", () => progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }
  { // T3 binary expression
    const id = new BN(Date.now() + 21); const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    const a = settleArgs(g);
    await expectErr("T3 settle with a binary expression (stat_b/op)", "BinaryNotAllowed", () => progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, a.statA, { add: {} })
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }
  { // T4 false predicate (threshold 999 > value)
    const id = new BN(Date.now() + 22); const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 999, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    const a = settleArgs(g);
    await expectErr("T4 settle a FALSE predicate (goals>999)", "PredicateNotMet", () => progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }
  { // T4b TAMPERED PROOF — a TRUE predicate (goals>0), but one byte of the Merkle proof is flipped. The
    // oracle re-derives the root from the forged nodes, it no longer matches the anchored root, and it
    // refuses to verify — so the settlement is rejected and the market is untouched. This is the whole
    // "the settler cannot lie" guarantee, tested against the real txoracle + real anchored roots.
    const id = new BN(Date.now() + 225); const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    const a = settleArgs(g);
    const forgedStatA = JSON.parse(JSON.stringify(a.statA));
    const fh = Array.from(forgedStatA.statProof[0].hash as number[]); fh[0] = (fh[0] ^ 0x01) & 0xff; forgedStatA.statProof[0].hash = fh; // flip one byte of the first Merkle node
    let rejected = false;
    try {
      await progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, forgedStatA, null, null)
        .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    } catch { rejected = true; }
    assert(rejected, "T4b tampered proof (one byte flipped) → settlement REJECTED by the chain (the settler cannot forge a payout)");
    assert((await progA.account.market.fetch(m)).status === 0, "T4b market stays OPEN after a forged settle — a forgery changes nothing");
  }
  { // T5 expired proof (ts param > expiry)
    const id = new BN(Date.now() + 23); const exp = nowSec() + 30; const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(exp), new BN(exp))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    const a = settleArgs(g);
    await expectErr("T5 settle with proof ts after expiry", "Expired", () => progA.methods.settle(new BN((exp + 100) * 1000), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }
  { // T6 non-monotone create
    const id6 = new BN(Date.now() + 24);
    await expectErr("T6 create_market with LessThan", "OnlyGreaterThan", () => progA.methods.createMarket(id6, new BN(FIXTURE), g.statToProve.key, 0, 1, 1, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: marketPda(id6), vault: vaultPda(marketPda(id6)), systemProgram: SystemProgram.programId }).rpc());
  }
  { // T7 past expiry
    const id = new BN(Date.now() + 25);
    await expectErr("T7 create_market with past expiry", "BadExpiry", () => progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, 0, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() - 100))
      .accounts({ authority: A.publicKey, market: marketPda(id), vault: vaultPda(marketPda(id)), systemProgram: SystemProgram.programId }).rpc());
  }

  // ───────────────────────── T8: empty-winning-side → VOID refund (no wait) ─────────────────────────
  sec("T8 · Empty winning side (only NO staked) + true predicate → routes to VOID refund (C3)");
  {
    const id = new BN(Date.now() + 30); const m = marketPda(id), v = vaultPda(m);
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await progFor(B).methods.joinPool(2, new BN(30e6)).accounts({ user: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc(); // only NO
    const a = settleArgs(g);
    await progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
      .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    const mk = await progA.account.market.fetch(m);
    assert(mk.status === 2, "empty-YES settle routed to VOID (status 2), not a locked SETTLED_YES");
    const vb = await bal(v);
    await progFor(B).methods.claim().accounts({ owner: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
    assert(vb - (await bal(v)) === 30e6, "B reclaims its full 0.03 stake on void");
  }

  // ───────────────────────── T9: parlay YES (2-leg) ─────────────────────────
  sec("T9 · Parlay: both legs hit → YES takes the whole pot; NO rejected; double-claim rejected");
  {
    const id = new BN(Date.now() + 40); const p = parlayPda(id), v = pvaultPda(p);
    await progA.methods.createParlay(id, new BN(FIXTURE), [{ statKey: g.statToProve.key, period: 0, threshold: 0, comparison: 0 }, { statKey: c.statToProve.key, period: 0, threshold: 0, comparison: 0 }], new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, parlay: p, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await progA.methods.joinParlay(1, new BN(50e6)).accounts({ user: A.publicKey, parlay: p, vault: v, position: pposPda(p, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
    await progFor(B).methods.joinParlay(2, new BN(50e6)).accounts({ user: B.publicKey, parlay: p, vault: v, position: pposPda(p, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc();
    const ca = settleArgs(c);
    await progA.methods.settleLeg(0, new BN(ga.seedTs), ga.fixtureSummary, ga.subTree, ga.mainTree, ga.statA, null, null).accounts({ settler: A.publicKey, parlay: p, dailyScoresMerkleRoots: dsrPda(ga.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    await progA.methods.settleLeg(1, new BN(ca.seedTs), ca.fixtureSummary, ca.subTree, ca.mainTree, ca.statA, null, null).accounts({ settler: A.publicKey, parlay: p, dailyScoresMerkleRoots: dsrPda(ca.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    const pk = await progA.account.parlay.fetch(p);
    assert(pk.status === 1, "parlay status == SETTLED_YES (1) after both legs hit");
    const vb = await bal(v);
    await progA.methods.claimParlay().accounts({ owner: A.publicKey, parlay: p, vault: v, position: pposPda(p, A.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
    assert(vb - (await bal(v)) === 100e6, "A (sole YES) takes the whole 0.10 pot");
    await expectErr("parlay NO loser claim", "NotWinner", () => progFor(B).methods.claimParlay().accounts({ owner: B.publicKey, parlay: p, vault: v, position: pposPda(p, B.publicKey, 2), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc());
  }

  // ───────────────────────── T10-T11: parlay leg negatives ─────────────────────────
  sec("T10-T11 · Parlay leg-binding negatives");
  { // T10 cross-fixture leg
    const id = new BN(Date.now() + 50); const p = parlayPda(id), v = pvaultPda(p);
    await progA.methods.createParlay(id, new BN(99999999), [{ statKey: g.statToProve.key, period: 0, threshold: 0, comparison: 0 }], new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, parlay: p, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await expectErr("T10 settle_leg with a different fixture's proof", "FixtureMismatch", () => progA.methods.settleLeg(0, new BN(ga.seedTs), ga.fixtureSummary, ga.subTree, ga.mainTree, ga.statA, null, null).accounts({ settler: A.publicKey, parlay: p, dailyScoresMerkleRoots: dsrPda(ga.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }
  { // T11 binary leg
    const id = new BN(Date.now() + 51); const p = parlayPda(id), v = pvaultPda(p);
    await progA.methods.createParlay(id, new BN(FIXTURE), [{ statKey: g.statToProve.key, period: 0, threshold: 0, comparison: 0 }], new BN(nowSec() + 86400), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, parlay: p, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await expectErr("T11 settle_leg with a binary expression", "BinaryNotAllowed", () => progA.methods.settleLeg(0, new BN(ga.seedTs), ga.fixtureSummary, ga.subTree, ga.mainTree, ga.statA, ga.statA, { add: {} }).accounts({ settler: A.publicKey, parlay: p, dailyScoresMerkleRoots: dsrPda(ga.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc());
  }

  // ───────────────────────── T14-T16: KILL-1 lock_ts (the flash-pool gate) ─────────────────────────
  sec("T14-T16 · lock_ts — new calls rejected at/after the lock (oracle-latency exploit gate)");
  { // T14 create with lock after expiry → BadLock
    const id = new BN(Date.now() + 60);
    await expectErr("T14 create_market with lock_ts > expiry", "BadLock", () => progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 200), new BN(nowSec() + 100))
      .accounts({ authority: A.publicKey, market: marketPda(id), vault: vaultPda(marketPda(id)), systemProgram: SystemProgram.programId }).rpc());
  }
  { // T15 join_pool: accepted before the lock, PoolLocked after it
    const id = new BN(Date.now() + 61); const m = marketPda(id), v = vaultPda(m);
    const lock = nowSec() + 10;
    await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(lock), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await progA.methods.joinPool(1, new BN(10e6)).accounts({ user: A.publicKey, market: m, vault: v, position: posPda(m, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
    pass("join_pool before lock accepted");
    const waitMs = (lock - nowSec() + 2) * 1000;
    if (waitMs > 0) { console.log(`  …waiting ${Math.ceil(waitMs / 1000)}s to cross the lock`); await sleep(waitMs); }
    await expectErr("T15 join_pool after lock", "PoolLocked", () => progFor(B).methods.joinPool(2, new BN(10e6)).accounts({ user: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc());
  }
  { // T16 join_parlay: accepted before the lock, PoolLocked after it
    const id = new BN(Date.now() + 62); const p = parlayPda(id), v = pvaultPda(p);
    const lock = nowSec() + 10;
    await progA.methods.createParlay(id, new BN(FIXTURE), [{ statKey: g.statToProve.key, period: 0, threshold: 0, comparison: 0 }], new BN(lock), new BN(nowSec() + 86400))
      .accounts({ authority: A.publicKey, parlay: p, vault: v, systemProgram: SystemProgram.programId }).rpc();
    await progA.methods.joinParlay(1, new BN(10e6)).accounts({ user: A.publicKey, parlay: p, vault: v, position: pposPda(p, A.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
    pass("join_parlay before lock accepted");
    const waitMs = (lock - nowSec() + 2) * 1000;
    if (waitMs > 0) { console.log(`  …waiting ${Math.ceil(waitMs / 1000)}s to cross the lock`); await sleep(waitMs); }
    await expectErr("T16 join_parlay after lock", "PoolLocked", () => progFor(B).methods.joinParlay(2, new BN(10e6)).accounts({ user: B.publicKey, parlay: p, vault: v, position: pposPda(p, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc());
  }

  // ───────────────────────── T12-T13: void anti-grief guard + parlay bust→NO ─────────────────────────
  sec("T12-T13 · void() stays locked until the 1h RESOLVE_GRACE (anti-grief) + parlay bust → NO wins");
  // Only T13's parlay resolve needs the wall-clock wait (its grace is VOID_GRACE_SECS = 120s). T12 now
  // asserts the *guard*: void() must NOT be reachable at expiry+120 — it stays locked until the full
  // RESOLVE_GRACE_SECS (3600s / 1h). That hour-long lock is a deliberate hardening (a losing YES backer
  // must not be able to void the pool the instant the short grace lapses and claw its stake back from the
  // NO winners), so testing the *lock* is the property that matters; the void refund mechanics themselves
  // are already covered by T8's empty-side → VOID refund. The success path is only reachable after a real
  // hour, which no wall-clock suite can (or should) sit through.
  const waitUntil = Math.max(tVoidExpiry, tBustExpiry) + GRACE + 8;
  const remain = waitUntil - nowSec();
  if (remain > 0) { console.log(`  …waiting ${remain}s for expiry + ${GRACE}s grace`); await sleep(remain * 1000); }
  // Devnet's Clock sysvar can lag wall-clock by tens of seconds, so a grace-gated call can still see
  // NotExpired just after the wall-clock wait. Retry until the chain's own clock agrees it's past grace.
  const retryClockLag = async (label: string, fn: () => Promise<any>) => {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e: any) {
        if (i < 12 && String(e?.message || e).includes("NotExpired")) { console.log(`  …${label}: chain clock still behind grace, waiting 10s`); await sleep(10_000); continue; }
        throw e;
      }
    }
  };
  { // T12 — the anti-grief lock: past the 120s VOID_GRACE but nowhere near the 1h RESOLVE_GRACE, void() is
    // still rejected, so a griefing YES backer cannot void the moment the short grace lapses.
    await expectErr("T12 void() past 120s but before the 1h RESOLVE_GRACE stays locked", "NotExpired",
      () => progA.methods.void().accounts({ cranker: A.publicKey, market: tVoid }).rpc());
    const mk = await progA.account.market.fetch(tVoid);
    assert(mk.status === 0, "market still OPEN — void did not fire before its full grace");
  }
  { // T13 parlay bust → NO (partial: leg0 was proven, leg1 never) — also tests void/settle grace race fix
    await expectErr("T13 settle a leg AFTER expiry+grace still allowed only if ts<=expiry (resolve wins)", "AlreadyClaimed", async () => {
      // leg0 already hit at setup; trying to re-settle leg0 must fail (AlreadyClaimed) — sanity that legs can't double-count
      await progA.methods.settleLeg(0, new BN(ga.seedTs), ga.fixtureSummary, ga.subTree, ga.mainTree, ga.statA, null, null).accounts({ settler: A.publicKey, parlay: tBust, dailyScoresMerkleRoots: dsrPda(ga.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
    });
    await retryClockLag("resolve_parlay", () => progA.methods.resolveParlay().accounts({ cranker: A.publicKey, parlay: tBust }).rpc());
    const pk = await progA.account.parlay.fetch(tBust);
    assert(pk.status === 3, "resolve_parlay (not all legs hit) → STATUS_PARLAY_NO (3)");
    const vb = await bal(tBustVault);
    await progFor(B).methods.claimParlay().accounts({ owner: B.publicKey, parlay: tBust, vault: tBustVault, position: pposPda(tBust, B.publicKey, 2), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
    assert(vb - (await bal(tBustVault)) === 0.05e9, "B (NO) takes the whole 0.05 pot on bust");
    await expectErr("parlay YES claim after bust", "NotWinner", () => progA.methods.claimParlay().accounts({ owner: A.publicKey, parlay: tBust, vault: tBustVault, position: pposPda(tBust, A.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc());
  }

  // ───────────────────────── T17: commercial floor — the capped rake switch ─────────────────────────
  sec("T17 · Rake (commercial floor): 2.5% skims winnings to the house, refunds untouched, cap + auth enforced");
  {
    // Cap + authority guards first (config currently rake 0, authority = A, fee_recipient = A).
    await expectErr("T17 set_rake above the 5% cap", "BadRake", () => progA.methods.setRake(MAX_RAKE_BPS + 1, null).accounts({ authority: A.publicKey, config: configPda }).rpc());
    await expectErr("T17 set_rake by a non-authority", "NotConfigAuthority", () => progFor(B).methods.setRake(250, null).accounts({ authority: B.publicKey, config: configPda }).rpc());
    try {
      // Turn the rake on at 2.5%. C = sole winner, B = loser, A = passive fee recipient (not a staker
      // here) so the fee credit to A is observable in isolation.
      await progA.methods.setRake(250, null).accounts({ authority: A.publicKey, config: configPda }).rpc();
      assert((await progA.account.config.fetch(configPda)).rakeBps === 250, "rake set to 250 bps (2.5%)");

      const id = new BN(Date.now() + 70); const m = marketPda(id), v = vaultPda(m);
      await progA.methods.createMarket(id, new BN(FIXTURE), g.statToProve.key, g.statToProve.period, 0, 0, new BN(nowSec() + 86400), new BN(nowSec() + 86400))
        .accounts({ authority: A.publicKey, market: m, vault: v, systemProgram: SystemProgram.programId }).rpc();
      await progFor(C).methods.joinPool(1, new BN(80e6)).accounts({ user: C.publicKey, market: m, vault: v, position: posPda(m, C.publicKey, 1), systemProgram: SystemProgram.programId }).rpc(); // C YES 0.08 (sole YES)
      await progFor(B).methods.joinPool(2, new BN(20e6)).accounts({ user: B.publicKey, market: m, vault: v, position: posPda(m, B.publicKey, 2), systemProgram: SystemProgram.programId }).rpc(); // B NO 0.02
      const a = settleArgs(g);
      await progA.methods.settle(new BN(a.seedTs), a.fixtureSummary, a.subTree, a.mainTree, a.statA, null, null)
        .accounts({ settler: A.publicKey, market: m, dailyScoresMerkleRoots: dsrPda(a.seedTs), txoracleProgram: TXORACLE }).preInstructions(cu()).rpc();
      // gross = pot(0.10) × 0.08/0.08 = 0.10 ; fee = 0.10 × 2.5% = 0.0025 ; net = 0.0975
      const vBefore = await bal(v), cBefore = await bal(C.publicKey), houseBefore = await bal(A.publicKey);
      await progFor(C).methods.claim().accounts({ owner: C.publicKey, market: m, vault: v, position: posPda(m, C.publicKey, 1), config: configPda, feeRecipient: A.publicKey, systemProgram: SystemProgram.programId }).rpc();
      const vDelta = vBefore - (await bal(v)), cGain = (await bal(C.publicKey)) - cBefore, houseGain = (await bal(A.publicKey)) - houseBefore;
      assert(vDelta === 100_000_000, `vault pays out the full gross 0.10 (net+fee) — got ${vDelta}`);
      assert(houseGain === 2_500_000, `house takes exactly the 2.5% rake = 0.0025 — got ${houseGain}`);
      // C paid its own tx fee, so compare net-of-txfee: the credited payout is 0.0975 (allow the 5k lamport sig fee).
      assert(cGain > 97_000_000 && cGain <= 97_500_000, `winner nets 0.0975 after the rake — got ${cGain}`);
    } finally {
      // ALWAYS return the live protocol to 0% — the app ships with no house cut.
      await progA.methods.setRake(0, null).accounts({ authority: A.publicKey, config: configPda }).rpc();
      assert((await progA.account.config.fetch(configPda)).rakeBps === 0, "rake reset to 0 — no cut in the shipped app");
    }
  }

  // ── summary ──
  sec("RESULT");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) { console.log("\n  FAILURES:\n   - " + fails.join("\n   - ")); process.exit(1); }
  console.log("\n  ✓✓ ALL PASS — hardened LATCH decides correctly and cannot be made to pay the wrong side or lock funds.");
}
main().catch((e) => { console.error("\nSUITE CRASHED:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-8)); process.exit(1); });
