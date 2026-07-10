import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/serverConfig";
import { serverProgram, settleMarket } from "@/lib/settleEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Settlement is permissionless on-chain — the kernel re-verifies the TxLINE Merkle proof against the
// oracle's anchored roots, so a bad crank can't settle a market wrongly. Anyone may crank; this route
// just fronts the fee with the server keypair. A light per-IP throttle keeps that fee-spend bounded.
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now(), win = hits.get(ip)?.filter((t) => now - t < 60_000) ?? [];
  if (win.length >= 8) { hits.set(ip, win); return true; }
  win.push(now); hits.set(ip, win); return false;
}

/** Permissionless keeper crank: discover an anchored proof for a market and settle it on-chain. */
export async function POST(req: NextRequest) {
  try {
    // The throttle exists to bound anonymous fee-spend, not to fight our own keeper: an authenticated
    // crank is exempt. Anyone may still settle permissionlessly — just not forty times a minute.
    if (!adminOk(req)) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
      if (throttled(ip)) return NextResponse.json({ settled: false, reason: "Easy — one collect at a time." }, { status: 429 });
    }
    const { market } = await req.json();
    const r = await settleMarket(serverProgram(), market);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
