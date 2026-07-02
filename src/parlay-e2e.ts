/**
 * LATCH parlay — end-to-end devnet proof (the multi-call slip's foundation).
 *
 * A 2-leg parlay over real World Cup stats: P1 to SCORE (goals key 1 > 0) AND P1 to win a
 * CORNER (corners key 7 > 0) — both true for fixture 17588388. Two wallets stake YES/NO;
 * each leg is proven independently via validate_stat (TxLINE-native); when both legs are
 * proven the parlay settles YES and the winner takes the whole pot. Proves the all-must-hit
 * combo settles trustlessly, leg-by-leg, on anchored data.
 *
 * Run:  npx ts-node src/parlay-e2e.ts   (after the parlay kernel is deployed + wallet funded)
 */
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import latchIdl from "../idl/latch.json";
import { TxlineClient, TXORACLE } from "./txline";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const FIXTURE = Number(process.env.FIXTURE || 17588388);
const PROGRAM_ID = new PublicKey((latchIdl as any).address);
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const sec = (t: string) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

function legArgs(bundle: any) {
  return {
    seedTs: Number(bundle.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new BN(bundle.summary.fixtureId),
      updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
      eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
    },
    statA: { statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) },
    subTree: bundle.subTreeProof.map(node),
    mainTree: bundle.mainTreeProof.map(node),
  };
}
const dsrPda = (seedTs: number) => PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(Math.floor(seedTs / 86400000)).toArrayLike(Buffer, "le", 2)], TXORACLE)[0];

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const A = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".devnet-key.json"), "utf8"))));
  const program: any = new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" }));

  sec("LATCH PARLAY · END-TO-END DEVNET PROOF");
  console.log("  program:", PROGRAM_ID.toBase58(), "| A:", A.publicKey.toBase58());

  // 0. find a seq where BOTH legs (P1 goals key 1, P1 corners key 7) have anchored proofs
  sec("0 · Fetch real proofs for both legs (P1 scores AND P1 wins a corner)");
  const tx = await new TxlineClient(conn, A).authenticate();
  const events = await tx.historicalEvents(FIXTURE);
  const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => b - a);
  let g: any = null, c: any = null, seq = 0;
  for (const i of [...new Set(Array.from({ length: 10 }, (_, k) => Math.floor((seqs.length - 1) * (k / 9))))]) {
    const gb = await tx.statValidation(FIXTURE, seqs[i], 1);
    const cb = await tx.statValidation(FIXTURE, seqs[i], 7);
    if (gb && cb) { g = gb; c = cb; seq = seqs[i]; break; }
  }
  if (!g || !c) throw new Error("could not find a seq with both leg proofs anchored");
  console.log(`  ✓ seq ${seq}: P1 goals=${g.statToProve.value} (key 1), P1 corners=${c.statToProve.value} (key 7) — both provable`);

  // 1. create the parlay: leg0 = goals>0, leg1 = corners>0
  sec("1 · Create 2-leg parlay (P1 to score AND P1 to win a corner)");
  const id = new BN(Date.now());
  const parlay = PublicKey.findProgramAddressSync([Buffer.from("parlay"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("pvault"), parlay.toBuffer()], PROGRAM_ID)[0];
  const legs = [
    { statKey: 1, period: 0, threshold: 0, comparison: 0 },
    { statKey: 7, period: 0, threshold: 0, comparison: 0 },
  ];
  const pExpiry = Math.floor(Date.now() / 1000) + 7 * 86400;
  const s1 = await program.methods.createParlay(id, new BN(FIXTURE), legs, new BN(pExpiry), new BN(pExpiry))
    .accounts({ authority: A.publicKey, parlay, vault, systemProgram: SystemProgram.programId }).rpc();
  console.log(`  ✓ parlay ${parlay.toBase58()} — ${s1.slice(0, 12)}…`);

  // 2. two wallets stake opposite sides
  sec("2 · Stake both sides (A=YES all-hit, B=NO busts), 0.05 each");
  const B = Keypair.generate();
  await new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" }).sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.2e9 })), []);
  const programB: any = new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(B), { commitment: "confirmed" }));
  const posA = PublicKey.findProgramAddressSync([Buffer.from("pposition"), parlay.toBuffer(), A.publicKey.toBuffer(), Buffer.from([1])], PROGRAM_ID)[0];
  const posB = PublicKey.findProgramAddressSync([Buffer.from("pposition"), parlay.toBuffer(), B.publicKey.toBuffer(), Buffer.from([2])], PROGRAM_ID)[0];
  await program.methods.joinParlay(1, new BN(0.05e9)).accounts({ user: A.publicKey, parlay, vault, position: posA, systemProgram: SystemProgram.programId }).rpc();
  await programB.methods.joinParlay(2, new BN(0.05e9)).accounts({ user: B.publicKey, parlay, vault, position: posB, systemProgram: SystemProgram.programId }).rpc();
  console.log(`  ✓ pot ${(await conn.getBalance(vault)) / 1e9} SOL`);

  // 3. settle each leg independently via validate_stat
  sec("3 · Settle each leg via validate_stat (TxLINE-native)");
  for (const [i, bundle] of [g, c].entries()) {
    const la = legArgs(bundle);
    const sig = await program.methods.settleLeg(i, new BN(la.seedTs), la.fixtureSummary, la.subTree, la.mainTree, la.statA, null, null)
      .accounts({ settler: A.publicKey, parlay, dailyScoresMerkleRoots: dsrPda(la.seedTs), txoracleProgram: TXORACLE })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
    const p: any = await program.account.parlay.fetch(parlay);
    console.log(`  ✓ leg ${i} (key ${legs[i].statKey}) proven — legs_hit ${p.legsHit}/${p.legs.length}, status ${p.status} — ${sig.slice(0, 12)}…`);
  }

  // 4. winner claims the whole pot; loser rejected
  sec("4 · Parlay hit → YES claims the pot");
  const m: any = await program.account.parlay.fetch(parlay);
  if (m.status !== 1) throw new Error("parlay did not settle YES (status " + m.status + ")");
  const before = await conn.getBalance(A.publicKey);
  await program.methods.claimParlay().accounts({ owner: A.publicKey, parlay, vault, position: posA, systemProgram: SystemProgram.programId }).rpc();
  const after = await conn.getBalance(A.publicKey);
  let bRejected = false;
  try { await programB.methods.claimParlay().accounts({ owner: B.publicKey, parlay, vault, position: posB, systemProgram: SystemProgram.programId }).rpc(); } catch { bRejected = true; }

  sec("RESULT");
  console.log(`  A (YES) net +${((after - before) / 1e9).toFixed(4)} SOL · vault now ${(await conn.getBalance(vault)) / 1e9} · B(NO) rejected: ${bRejected}`);
  console.log(after > before && bRejected ? "  ✓✓ PASS — a 2-leg parlay settled leg-by-leg on real proofs; all hit → YES took the pot." : "  ✗ FAIL");
}
main().catch((e) => { console.error("FAIL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-8)); process.exit(1); });
