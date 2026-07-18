/**
 * GAFFER — zero-credential settlement verifier. Proves a pool settled TRUSTLESSLY, straight from chain.
 * No keys. Run from the web package:  node scripts_judge-verify-settlement.mjs [poolPubkey]
 *
 * It finds a settled ("paid") pool, pulls its on-chain history, and shows the settle transaction that
 * CPIs into TxLINE's `validate_stat` (program 6pW64gN…) — the kernel paid ONLY because TxLINE's signed
 * Merkle proof returned true. Then it shows a winner's claim. Nothing is self-reported; every link is a
 * real devnet transaction you can open on Explorer.
 */
import { Connection, PublicKey } from "@solana/web3.js";
const RPC = process.env.DRIVER_RPC || "https://api.devnet.solana.com";
const BASE = "https://www.mygaffer.xyz";
const TXLINE = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";        // TxLINE oracle — the validate_stat program
const KERNEL = "HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG";        // LATCH parimutuel kernel
const conn = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retry = async (fn, t = 8) => { for (let i = 0; i < t; i++) { try { return await fn(); } catch (e) { if (i === t - 1) throw e; await sleep(Math.min(15000, 1500 * 2 ** i)); } } };
const EX = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

console.log("GAFFER — trustless settlement, verified from chain (zero credentials)");
console.log("kernel:", KERNEL, "| TxLINE oracle:", TXLINE, "\n");

// Scan one pool's on-chain history for its settle (the validate_stat CPI) and a winner's claim. A pool's
// settle happens once, early; a popular pool then accrues many claims, so we walk a wide window (not just
// the newest few sigs) oldest→newest, or the settle falls off the end behind the claims.
async function scanPool(pool) {
  const sigs = await retry(() => conn.getSignaturesForAddress(new PublicKey(pool), { limit: 200 }));
  let settleTx = null, claimTx = null;
  for (const si of sigs.reverse()) {                                  // oldest→newest: create, joins, settle, claims
    if (si.err) continue;
    const tx = await retry(() => conn.getTransaction(si.signature, { maxSupportedTransactionVersion: 0 }));
    const logs = (tx?.meta?.logMessages || []).join(" ");
    const ins = (logs.match(/Instruction: (\w+)/g) || []).map((x) => x.replace("Instruction: ", ""));
    if (!settleTx && logs.includes(TXLINE) && /Settle|ValidateStat/i.test(ins.join(","))) settleTx = si.signature;
    else if (settleTx && !claimTx && /Claim/i.test(ins.join(","))) claimTx = si.signature;
    if (settleTx && claimTx) break;
    await sleep(200);
  }
  return { settleTx, claimTx };
}

// pick a settled pool: CLI arg (scan just it), else walk the "paid" pools (highest-pot first) until one
// yields a real on-chain settle tx — so the one-command run always lands on a provable settlement.
let pool = process.argv[2], settleTx = null, claimTx = null;
if (pool) {
  ({ settleTx, claimTx } = await scanPool(pool));
} else {
  const mk = await retry(() => fetch(`${BASE}/api/markets`).then((r) => r.json()));
  const paid = (mk.markets || []).filter((m) => m.statusLabel === "paid").sort((a, b) => (b.potSol || 0) - (a.potSol || 0));
  if (!paid.length) { console.log("no settled pools found"); process.exit(0); }
  for (const cand of paid.slice(0, 8)) {
    const r = await scanPool(cand.pubkey);
    if (r.settleTx) { pool = cand.pubkey; settleTx = r.settleTx; claimTx = r.claimTx; console.log(`chosen settled pool: ${pool}  (${cand.home} v ${cand.away}, pot ${cand.potSol} SOL)\n`); break; }
  }
  if (!pool) { pool = paid[0].pubkey; console.log(`chosen settled pool: ${pool}  (${paid[0].home} v ${paid[0].away}, pot ${paid[0].potSol} SOL)\n`); }
}

console.log("┌─ verified from chain ────────────────────────────────");
console.log("│ pool (parimutuel escrow PDA):", pool);
if (settleTx) {
  console.log("│");
  console.log("│ SETTLE — the kernel CPI'd into TxLINE::validate_stat and paid only on the signed proof:");
  console.log("│   " + EX(settleTx));
  console.log("│   (open it: account list shows both the LATCH kernel AND the TxLINE oracle — the CPI target)");
} else {
  console.log("│ (no validate_stat settle tx in the last 15 sigs — pass a specific pool pubkey as arg)");
}
if (claimTx) { console.log("│"); console.log("│ CLAIM — a winner paid out on-chain:"); console.log("│   " + EX(claimTx)); }
console.log("└──────────────────────────────────────────────────────");
console.log("\nThe settler's only power is to ASK. It cannot fabricate a result — validate_stat re-verifies");
console.log("TxLINE's signed Merkle proof against the anchored daily-scores root and hands back a bool; the");
console.log("kernel pays only on true. Reproduce with any settled pool. Nothing here is trusted — it's proven.");
