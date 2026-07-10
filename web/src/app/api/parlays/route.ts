import { NextResponse } from "next/server";
import { listParlays } from "@/lib/kernel";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every live slip, coalesced.
 *
 * `getProgramAccounts` is the most expensive call in the RPC's vocabulary, and the browser was making
 * one per client every fifteen seconds. Two tabs open on a public devnet endpoint is enough to earn a
 * 429 — a room of fans watching the same match would take each other's app down, which is precisely the
 * moment the app exists for. Pools already came through this door (`/api/markets`); slips were still
 * going straight to the chain from every phone.
 *
 * Same contract as markets: one upstream call however many people ask, and a slightly stale list beats
 * an error page when the RPC blinks.
 */
export async function GET() {
  try {
    const parlays = await cached("parlays", { ttlMs: 3000, swrMs: 30_000, staleMs: 60_000 }, listParlays);
    return NextResponse.json({ parlays });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
