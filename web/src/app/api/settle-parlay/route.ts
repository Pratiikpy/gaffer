import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/serverConfig";
import { serverProgram, settleParlay } from "@/lib/settleEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keeper crank for a parlay: prove every still-open leg from anchored data; once all legs hit it
 * settles YES, and if it's past expiry+grace without all legs hitting, resolve it to NO. */
export async function POST(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { parlay } = await req.json();
    const r = await settleParlay(serverProgram(), parlay);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
