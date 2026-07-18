import "server-only";
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { RPC } from "@/lib/config";

/**
 * Calls the on-chain TxLINE `txoracle::validate_stat` with a real signed proof (and a byte-forged copy)
 * via read-only simulation — the machinery behind the "the settler cannot lie" demo. The exact same
 * bytes the LATCH kernel emits when it settles (layout from latch/programs/latch/src/lib.rs). No funds,
 * no signature: the fee-payer is any existing devnet account and simulation moves nothing.
 */
export const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const VALIDATE_STAT_DISC = Buffer.from([107, 197, 232, 90, 191, 136, 105, 185]);
const PAYER = new PublicKey("Eubd72SuAMGvxZGgt2DjdNUrBPYyoUM2diWbbKViDXhr"); // existing acct; fee-payer only

const i64 = (n: any) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(Number(n)))); return b; };
const i32 = (n: any) => { const b = Buffer.alloc(4); b.writeInt32LE(Number(n)); return b; };
const u32 = (n: any) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
function buf32(h: any): Buffer {
  if (Buffer.isBuffer(h)) return h;
  if (Array.isArray(h)) return Buffer.from(h);
  if (h?.type === "Buffer" && Array.isArray(h.data)) return Buffer.from(h.data);
  if (typeof h === "string") return Buffer.from(h.replace(/^0x/, ""), /^[0-9a-fA-F]{64}$/.test(h.replace(/^0x/, "")) ? "hex" : "base64");
  throw new Error("unknown hash shape");
}
const node = (nd: any) => Buffer.concat([buf32(nd.hash), Buffer.from([nd.isRightSibling ? 1 : 0])]);
const vecNodes = (arr: any[]) => Buffer.concat([u32(arr.length), ...arr.map(node)]);

export function encodeValidateStat(bundle: any): Buffer {
  const s = bundle.summary;
  return Buffer.concat([
    VALIDATE_STAT_DISC,
    i64(s.updateStats.minTimestamp),
    i64(s.fixtureId), i32(s.updateStats.updateCount), i64(s.updateStats.minTimestamp), i64(s.updateStats.maxTimestamp), buf32(s.eventStatsSubTreeRoot),
    vecNodes(bundle.subTreeProof),
    vecNodes(bundle.mainTreeProof),
    i32(0), Buffer.from([0]), // predicate { threshold: 0, comparison: GreaterThan }  → "value > 0"
    u32(bundle.statToProve.key), i32(bundle.statToProve.value), i32(bundle.statToProve.period), buf32(bundle.eventStatRoot), vecNodes(bundle.statProof),
    Buffer.from([0]), Buffer.from([0]), // stat_b: None, op: None
  ]);
}

export function forgeBundle(bundle: any): any {
  const f = JSON.parse(JSON.stringify(bundle));
  const h = buf32(f.statProof[0].hash); h[0] ^= 0x01; f.statProof[0].hash = [...h]; // flip 1 bit of the first Merkle node
  return f;
}

export function dsrPda(minTsMs: number): PublicKey {
  const b = Buffer.alloc(2); b.writeUInt16LE(Math.floor(minTsMs / 86400000));
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), b], TXORACLE)[0];
}

export async function probe(bundle: any): Promise<{ verdict: boolean | null; rejected: boolean; err: string | null; cu: number | null }> {
  const conn = new Connection(RPC, "confirmed");
  const dsr = dsrPda(Number(bundle.summary.updateStats.minTimestamp));
  const ix = new TransactionInstruction({ programId: TXORACLE, keys: [{ pubkey: dsr, isSigner: false, isWritable: false }], data: encodeValidateStat(bundle) });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: PAYER, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const rd = sim.value.returnData;
  const cu = sim.value.unitsConsumed ?? null;
  if (rd) { const ok = Buffer.from(rd.data[0], "base64")[0] === 1; return { verdict: ok, rejected: !ok, err: null, cu }; }
  return { verdict: null, rejected: true, err: sim.value.err ? JSON.stringify(sim.value.err) : "no verdict", cu };
}
