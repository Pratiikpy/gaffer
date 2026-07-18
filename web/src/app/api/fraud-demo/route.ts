import { NextResponse } from "next/server";
import { fetchAnchoredProof } from "@/lib/proofSource";
import { probe, forgeBundle, dsrPda } from "@/lib/oracleProbe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Can the settler lie?" — proven live. Pulls a real signed TxLINE proof, then calls the on-chain
 * txoracle `validate_stat` two ways: with the real proof (→ TRUE, the kernel would pay) and with one
 * byte flipped (→ rejected, root mismatch). Read-only simulation; nothing is spent. Powers /fraud.
 */
let cache: { at: number; v: any } | null = null;
const TTL = 3 * 60_000;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json(cache.v);
  try {
    const found = await fetchAnchoredProof();
    if (!found) return NextResponse.json({ error: "no anchored proof available right now" }, { status: 503 });
    const { bundle, fixtureId, seq, statKey } = found;
    const real = await probe(bundle);
    const forged = await probe(forgeBundle(bundle));
    const dsr = dsrPda(Number(bundle.summary.updateStats.minTimestamp)).toBase58();
    const v = {
      fixtureId, seq, statKey,
      statValue: Number(bundle.statToProve.value),
      oracle: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
      dsr,
      real,   // { verdict:true, rejected:false, cu }
      forged, // { verdict:null|false, rejected:true, err, cu }
      proven: real.verdict === true && forged.rejected === true,
      updatedAt: Date.now(),
    };
    if (v.proven) cache = { at: Date.now(), v };
    return NextResponse.json(v);
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 160) }, { status: 500 });
  }
}
