/** Keeper demo — create a REAL market, stake both sides, then let the keeper settle it
 * UNATTENDED (it discovers the proof and fires settlement itself). Proves autonomous operation. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { Kernel, COMPARISON, SIDE } from "./kernel";
import { TxlineClient } from "./txline";
import { Keeper } from "./keeper";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const FIXTURE = Number(process.env.FIXTURE || 17588388);
const sec = (t: string) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const A = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".devnet-key.json"), "utf8"))));
  const kernel = new Kernel(conn, A);

  sec("KEEPER DEMO · autonomous settlement of a real market");
  console.log("  authenticating with TxLINE…");
  const tx = await new TxlineClient(conn, A).authenticate();
  console.log("  ✓ authenticated");

  // Market: "Does P1 score in the first half?"  →  P1 H1 goals > 0  (statKey 1, period 4 = H1, GreaterThan 0)
  const id = new BN(Date.now());
  const { market } = await kernel.createMarket(id, FIXTURE, 1, 4, 0, COMPARISON.GreaterThan, Math.floor(Date.now() / 1000) + 7 * 86400);
  console.log(`  ✓ market ${market.toBase58()} — "P1 scores in the first half?"`);

  // Two wallets stake opposite sides
  const B = Keypair.generate();
  await new AnchorProvider(conn, new Wallet(A), { commitment: "confirmed" })
    .sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.2e9 })), []);
  await kernel.joinPool(market, A, SIDE.YES, 0.05e9);
  await kernel.joinPool(market, B, SIDE.NO, 0.05e9);
  console.log(`  ✓ staked: A YES 0.05, B NO 0.05 — pot ${(await conn.getBalance(kernel.vaultPda(market))) / 1e9} SOL`);

  sec("Running the keeper — NO human input from here");
  const keeper = new Keeper(kernel, tx);
  await keeper.runLoop(8000, 6);

  sec("RESULT");
  const m: any = await kernel.fetchMarket(market);
  console.log("  market status:", m.status, "(1 = SettledYes)");
  if (m.status === 1) {
    const before = await conn.getBalance(A.publicKey);
    await kernel.claim(market, A, SIDE.YES);
    const after = await conn.getBalance(A.publicKey);
    console.log(`  ✓✓ PASS — the keeper settled a real market autonomously; winner A claimed +${((after - before) / 1e9).toFixed(4)} SOL (the whole pot).`);
  } else {
    console.log("  ✗ market did not settle (status " + m.status + ") — see keeper ticks above.");
    process.exit(1);
  }
}
main().catch((e) => { console.error("FAIL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-6)); process.exit(1); });
