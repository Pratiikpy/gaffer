import { NextRequest, NextResponse } from "next/server";
import { fetchAnchoredProof } from "@/lib/proofSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, read-only: hands back a REAL signed TxLINE proof bundle for a finished, anchored fixture so
 * anyone can independently re-verify it against the on-chain txoracle — or flip a byte and watch the
 * chain reject it. The bundle is TxLINE's own signed data (meant to be verifiable); the server only
 * performs the feed auth the browser can't. Powers `scripts_judge-verify-fraud.mjs` and the /fraud demo.
 * Self-healing: walks recent finished fixtures until one still verifies, so the demo never goes dark.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const found = await fetchAnchoredProof(Number(p.get("fixtureId") || 0), Number(p.get("statKey") || 1));
    if (!found) return NextResponse.json({ error: "no anchored proof available right now (recent fixtures may have aged out of daily_scores_roots)" }, { status: 404 });
    return NextResponse.json({ ...found, oracle: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J" });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 160) }, { status: 500 });
  }
}
