/**
 * LATCH kernel — end-to-end devnet proof.
 *
 * Two independent wallets stake opposite sides of a real World Cup market; the market
 * self-settles by CPI into TxLINE's validate_stat over a real Merkle proof; the winner
 * claims the WHOLE pot. This is the on-chain version of the Phase-0 spike: it proves the
 * kernel moves the loser's money to the winner purely on a cryptographic proof — no
 * operator, no custodian, no human deciding the outcome.
 *
 * Run:  npx ts-node src/kernel-e2e.ts     (wallet A = .devnet-key.json must hold ~1 SOL)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import axios from "axios";
import * as nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";
import latchIdl from "../idl/latch.json";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const API = "https://txline-dev.txodds.com";
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const SUB_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const FIXTURE = Number(process.env.FIXTURE || 17588388);
const SEQ = Number(process.env.SEQ || 828);
const STAKE = 0.05 * 1e9; // lamports each side
const sec = (t: string) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));
const ok = (s: string) => console.log("  ✓ " + s);
const ex = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });

async function getProof(conn: Connection, A: Keypair) {
  const http = axios.create({ baseURL: API, timeout: 30000, headers: { "Content-Type": "application/json" } });
  const jwt = (await http.post("/auth/guest/start")).data.token;
  http.defaults.headers.common["Authorization"] = `Bearer ${jwt}`;

  // subscribe (free SL1, 4 weeks) — needed to mint an apiToken
  const provider = new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" });
  const tx: any = new Program(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "idl", "txoracle.json"), "utf8")), provider);
  const [pricing] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], TXORACLE);
  const [treas] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], TXORACLE);
  const vault = getAssociatedTokenAddressSync(SUB_MINT, treas, true, TOKEN_2022_PROGRAM_ID);
  const ata = await getOrCreateAssociatedTokenAccount(conn, A, SUB_MINT, A.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  const subSig: string = await tx.methods.subscribe(1, 4).accounts({
    user: A.publicKey, pricingMatrix: pricing, tokenMint: SUB_MINT, userTokenAccount: ata.address,
    tokenTreasuryVault: vault, tokenTreasuryPda: treas, tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  console.log("    subscribed:", subSig.slice(0, 16), "…");
  const msg = new TextEncoder().encode(`${subSig}::${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(msg, A.secretKey)).toString("base64");
  let apiToken: string;
  try {
    const ar = (await axios.post(`${API}/api/token/activate`, { txSig: subSig, walletSignature, leagues: [] }, { headers: { Authorization: `Bearer ${jwt}` } })).data;
    apiToken = ar.token || ar;
    console.log("    activated apiToken:", String(apiToken).slice(0, 12), "…");
  } catch (e: any) { throw new Error(`activate ${e.response?.status}: ${JSON.stringify(e.response?.data)}`); }
  http.defaults.headers.common["X-Api-Token"] = apiToken;
  try {
    const v = (await http.get("/api/scores/stat-validation", { params: { fixtureId: FIXTURE, seq: SEQ, statKey: 1 } })).data;
    if (!v?.ts) throw new Error("no proof bundle for fixture " + FIXTURE + " seq " + SEQ);
    return v;
  } catch (e: any) { throw new Error(`stat-validation ${e.response?.status || ""}: ${JSON.stringify(e.response?.data) || e.message}`); }
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const A = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".devnet-key.json"), "utf8"))));
  const providerA = new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" });
  anchor.setProvider(providerA);
  const program: any = new Program(latchIdl as any, providerA);

  sec("LATCH KERNEL · END-TO-END DEVNET PROOF");
  console.log("  program:", program.programId.toBase58());
  console.log("  wallet A (YES):", A.publicKey.toBase58(), (await conn.getBalance(A.publicKey)) / 1e9, "SOL");

  // 0. fetch a real proof bundle first (its stat key/period define the market)
  sec("0 · Fetch a real World Cup proof from TxLINE");
  const bundle = await getProof(conn, A);
  const statKey = bundle.statToProve.key, period = bundle.statToProve.period, value = bundle.statToProve.value;
  const seedTs = Number(bundle.summary.updateStats.minTimestamp);
  const epochDay = Math.floor(seedTs / 86400000);
  const [dsr] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXORACLE);
  ok(`proof: fixture ${FIXTURE} seq ${SEQ} → P1 stat key ${statKey} period ${period} value ${value}; root PDA exists`);

  // 1. create a market: YES = "this stat is over -1" (monotone over-threshold, always true since
  //    stats are ≥ 0 → YES wins deterministically). v1 kernel is GreaterThan-only.
  sec("1 · Create market (YES = stat > -1)");
  const marketId = new BN(Date.now());
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program.programId);
  const mExpiry = seedTs + 86400000; // lock == expiry: this test doesn't exercise the lock window
  const sig1 = await program.methods.createMarket(marketId, new BN(FIXTURE), statKey, period, -1, 0, new BN(mExpiry), new BN(mExpiry))
    .accounts({ authority: A.publicKey, market, vault, systemProgram: SystemProgram.programId }).rpc();
  ok(`market ${market.toBase58()} created — ${ex(sig1)}`);

  // 2. two wallets stake opposite sides
  sec("2 · Stake both sides (A=YES, B=NO), 0.05 SOL each");
  const B = Keypair.generate();
  const fundB = new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.2 * 1e9 }));
  await providerA.sendAndConfirm(fundB, []);
  ok("wallet B (NO): " + B.publicKey.toBase58() + " funded 0.2 SOL");
  const programB: any = new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(B), { commitment: "confirmed" }));

  const [posA] = PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), A.publicKey.toBuffer(), Buffer.from([1])], program.programId);
  const [posB] = PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), B.publicKey.toBuffer(), Buffer.from([2])], program.programId);
  const sA = await program.methods.joinPool(1, new BN(STAKE)).accounts({ user: A.publicKey, market, vault, position: posA, systemProgram: SystemProgram.programId }).rpc();
  ok("A staked YES 0.05 — " + ex(sA));
  const sB = await programB.methods.joinPool(2, new BN(STAKE)).accounts({ user: B.publicKey, market, vault, position: posB, systemProgram: SystemProgram.programId }).rpc();
  ok("B staked NO 0.05 — " + ex(sB));
  console.log("  vault now holds:", (await conn.getBalance(vault)) / 1e9, "SOL (the 0.1 pot)");

  // 3. settle via the real validate_stat CPI
  sec("3 · Self-settle via validate_stat CPI (the trustless step)");
  const fixtureSummary = {
    fixtureId: new BN(bundle.summary.fixtureId),
    updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
    eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
  };
  const statA = { statToProve: { key: statKey, value, period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) };
  const sig3 = await program.methods.settle(new BN(seedTs), fixtureSummary, bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), statA, null, null)
    .accounts({ settler: A.publicKey, market, dailyScoresMerkleRoots: dsr, txoracleProgram: TXORACLE })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
  const m = await program.account.market.fetch(market);
  ok(`settled — status=${m.status} (1=SettledYes) — ${ex(sig3)}`);
  if (m.status !== 1) throw new Error("market did not settle YES");

  // 4. winner (A) claims the whole pot; loser (B) cannot
  sec("4 · Winner claims the pot; loser is rejected");
  const aBefore = await conn.getBalance(A.publicKey);
  const sig4 = await program.methods.claim().accounts({ owner: A.publicKey, market, vault, position: posA, systemProgram: SystemProgram.programId }).rpc();
  const aAfter = await conn.getBalance(A.publicKey);
  const vaultAfter = await conn.getBalance(vault);
  ok(`A claimed — balance ${(aBefore / 1e9).toFixed(4)} → ${(aAfter / 1e9).toFixed(4)} SOL (net +${((aAfter - aBefore) / 1e9).toFixed(4)} incl. fees) — ${ex(sig4)}`);
  ok(`vault drained to ${(vaultAfter / 1e9).toFixed(6)} SOL`);
  let bRejected = false;
  try { await programB.methods.claim().accounts({ owner: B.publicKey, market, vault, position: posB, systemProgram: SystemProgram.programId }).rpc(); }
  catch { bRejected = true; }
  ok(`B (NO, the loser) claim rejected: ${bRejected}`);

  sec("RESULT");
  const won = aAfter - aBefore > 0;
  console.log(won && m.status === 1 && bRejected
    ? "  ✓✓ PASS — the kernel self-settled a real World Cup proof on devnet and moved the loser's stake to the winner. No operator, no custodian."
    : "  ✗ FAIL — see above.");
}
main().catch((e) => { console.error("\nFAIL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-8)); process.exit(1); });
