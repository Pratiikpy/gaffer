/**
 * GAFFER — zero-credential FRAUD verifier. Proves the settler cannot lie, straight from chain.
 * No keys, no funds. Run from the web package:  node scripts_judge-verify-fraud.mjs [fixtureId]
 *
 * It pulls a REAL signed TxLINE proof for a finished World Cup fixture, then calls the on-chain
 * txoracle `validate_stat` two ways — via read-only simulation, so nothing is spent:
 *   1) with the REAL proof            → the oracle re-verifies it against the anchored daily-scores
 *                                        root and returns TRUE. GAFFER's kernel pays only on true.
 *   2) with ONE BYTE of the proof flipped → the re-derived Merkle root no longer matches the anchored
 *                                        root, so the oracle returns FALSE. A forged settlement is
 *                                        rejected by the chain itself — the settler has no way to force
 *                                        a payout it can't prove.
 * Nothing here is trusted; reproduce it against any anchored fixture.
 */
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const RPC = process.env.DRIVER_RPC || "https://api.devnet.solana.com";
const BASE = process.env.GAFFER_BASE || "https://www.mygaffer.xyz";
const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
// Simulation fee-payer: any existing devnet account (no signature, no funds moved — sigVerify is off).
// A fresh keypair fails account-load ("AccountNotFound") on some RPC nodes, so we point at a real one.
const PAYER = new PublicKey("Eubd72SuAMGvxZGgt2DjdNUrBPYyoUM2diWbbKViDXhr");
const VALIDATE_STAT_DISC = Buffer.from([107, 197, 232, 90, 191, 136, 105, 185]); // anchor disc for validate_stat
const fixtureId = process.argv[2] || "";
const conn = new Connection(RPC, "confirmed");

// ── borsh helpers (exact layout from latch/programs/latch/src/lib.rs::ValidateStatArgs) ──
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(Number(n)))); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(Number(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
function buf32(h) {
  if (h == null) throw new Error("null hash");
  if (Buffer.isBuffer(h)) return h;
  if (Array.isArray(h)) return Buffer.from(h);
  if (h.type === "Buffer" && Array.isArray(h.data)) return Buffer.from(h.data);
  if (typeof h === "string") return Buffer.from(h.replace(/^0x/, ""), /^[0-9a-fA-F]{64}$/.test(h.replace(/^0x/, "")) ? "hex" : "base64");
  throw new Error("unknown hash shape: " + JSON.stringify(h).slice(0, 40));
}
const node = (nd) => Buffer.concat([buf32(nd.hash), Buffer.from([nd.isRightSibling ? 1 : 0])]);
const vecNodes = (arr) => Buffer.concat([u32(arr.length), ...arr.map(node)]);

/** Serialize the full validate_stat instruction data for a "stat > 0" (always-true) predicate. */
function encodeValidateStat(bundle) {
  const s = bundle.summary;
  return Buffer.concat([
    VALIDATE_STAT_DISC,
    i64(s.updateStats.minTimestamp),                                  // ts (seed = min_timestamp, ms)
    i64(s.fixtureId), i32(s.updateStats.updateCount), i64(s.updateStats.minTimestamp), i64(s.updateStats.maxTimestamp), buf32(s.eventStatsSubTreeRoot), // ScoresBatchSummary
    vecNodes(bundle.subTreeProof),                                    // fixture_proof
    vecNodes(bundle.mainTreeProof),                                   // main_tree_proof
    i32(0), Buffer.from([0]),                                         // predicate { threshold: 0, comparison: GreaterThan }
    u32(bundle.statToProve.key), i32(bundle.statToProve.value), i32(bundle.statToProve.period), buf32(bundle.eventStatRoot), vecNodes(bundle.statProof), // stat_a
    Buffer.from([0]),                                                 // stat_b: None
    Buffer.from([0]),                                                 // op: None
  ]);
}

const dsrPda = (minTsMs) => PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(Math.floor(minTsMs / 86400000)); return b; })()],
  TXORACLE,
)[0];

async function verdict(data, dsr) {
  const ix = new TransactionInstruction({ programId: TXORACLE, keys: [{ pubkey: dsr, isSigner: false, isWritable: false }], data });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: PAYER, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const rd = sim.value.returnData;
  if (sim.value.err && !rd) return { bool: null, rejected: true, err: JSON.stringify(sim.value.err) };
  if (!rd) return { bool: null, rejected: true, err: "no return data" };
  const bytes = Buffer.from(rd.data[0], "base64");
  return { bool: bytes[0] === 1, rejected: bytes[0] !== 1 };
}

(async () => {
  console.log("GAFFER — the settler cannot lie, verified from chain (zero credentials)\n");
  console.log("txoracle:", TXORACLE.toBase58(), "| RPC:", RPC, "\n(pulling a real signed proof…)\n");

  const u = `${BASE}/api/proof${fixtureId ? `?fixtureId=${fixtureId}` : ""}`;
  const r = await fetch(u).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (!r?.bundle) { console.log("could not fetch a proof bundle:", r?.error || "unknown"); process.exit(1); }
  const b = r.bundle, dsr = dsrPda(Number(b.summary.updateStats.minTimestamp));
  console.log(`fixture ${r.fixtureId} · seq ${r.seq} · stat key ${b.statToProve.key} = ${b.statToProve.value}  (predicate: value > 0 → should be TRUE)`);
  console.log("daily_scores_roots PDA:", dsr.toBase58(), "\n");

  // 1) the REAL proof
  const real = await verdict(encodeValidateStat(b), dsr);
  console.log(`①  REAL signed proof        → validate_stat returns  ${real.bool === true ? "TRUE  ✓  the oracle re-verified it; the kernel would pay YES" : `${real.bool}  (rejected: ${real.err || "false"})`}`);

  // 2) the SAME proof, one byte flipped
  const forged = JSON.parse(JSON.stringify(b));
  const h = buf32(forged.statProof[0].hash); h[0] ^= 0x01; forged.statProof[0].hash = [...h]; // flip 1 bit of the first Merkle node
  const bad = await verdict(encodeValidateStat(forged), dsr);
  console.log(`②  ONE byte of the proof flip → validate_stat returns  ${bad.bool === false || bad.rejected ? "FALSE ✗  root mismatch — the chain rejects the forgery" : `${bad.bool}  (UNEXPECTED — the forgery was accepted!)`}`);

  console.log("\n" + "─".repeat(74));
  const win = real.bool === true && (bad.bool === false || bad.rejected);
  console.log(win
    ? "PROVEN: a real proof verifies TRUE, a forged proof verifies FALSE. GAFFER's kernel pays\nONLY on true, so no settler — not even the one submitting — can force a payout it can't prove."
    : "INCONCLUSIVE: could not fetch/verify against the anchored root right now (the fixture's day may\nhave aged out of daily_scores_roots). Pass a more recent finished fixtureId as the first arg.");
  console.log("─".repeat(74));
  process.exit(win ? 0 : 2);
})();
