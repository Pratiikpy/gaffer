import { NextRequest, NextResponse } from "next/server";
import { txline } from "@/lib/txline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live-ish scores for a fixture (server proxies TxLINE; the token never reaches the browser). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await params;
  const id = Number(fixtureId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "unknown match" }, { status: 400 });
  try {
    const events = await txline().historicalEvents(id);
    const withSeq = events.filter((e) => (e.seq ?? e.Seq) != null);
    const last = withSeq[withSeq.length - 1] ?? events[events.length - 1] ?? null;
    return NextResponse.json({
      fixtureId: id,
      count: events.length,
      latestSeq: last ? (last.seq ?? last.Seq) : null,
      recent: withSeq.slice(-30),
    });
  } catch {
    // Never leak a raw upstream/axios string to the client.
    return NextResponse.json({ error: "match feed unavailable" }, { status: 502 });
  }
}
