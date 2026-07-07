import { NextRequest, NextResponse } from "next/server";
import { saveSub } from "@/lib/push";
import { tokenOk } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → the VAPID public key the browser needs to subscribe (safe to expose). */
export async function GET() {
  return NextResponse.json({ key: process.env.VAPID_PUBLIC || process.env.NEXT_PUBLIC_VAPID_PUBLIC || "" });
}

/** POST → register this device's push subscription for the user. Token-guarded so a stranger can't
 * attach a subscription to someone else's id. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const userId = String(b.userId || "");
    if (!userId || !(await tokenOk(userId, String(b.token || "")))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    await saveSub(userId, b.subscription, b.squadCode || null);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || "bad request").slice(0, 100) }, { status: 400 });
  }
}
