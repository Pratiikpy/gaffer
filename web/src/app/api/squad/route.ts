import { NextRequest, NextResponse } from "next/server";
import { createSquad, joinSquad, postMessage, recordCall, react, syncMember, authed } from "@/lib/squadStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    // create/join issue the caller's token. A member id is required — reject a missing one with a
    // plain 400 rather than letting `owner.id!` throw into a raw 500.
    if (b.action === "create" || b.action === "join") {
      if (!b.member?.id || typeof b.member.id !== "string") return NextResponse.json({ error: "missing member" }, { status: 400 });
      if (b.action === "create") return NextResponse.json(await createSquad(b.name, b.member));
      const r = await joinSquad(b.code, b.member);
      return r ? NextResponse.json(r) : NextResponse.json({ error: "squad not found" }, { status: 404 });
    }

    // all mutations require the caller's own token → no impersonating another user
    if (!(await authed(b.code, b.userId, b.token))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    let squad = null;
    switch (b.action) {
      case "post": squad = await postMessage(b.code, b.userId, b.name, b.text); break;
      // A recorded call may carry a sealed Called Shot line (item 15); points are NEVER taken from the body.
      case "call": squad = await recordCall(b.code, b.userId, b.name, b.market, b.side, b.q, b.sealed); break;
      case "react": squad = await react(b.code, b.msgId, b.emoji, b.userId); break;
      // sync only touches the caller's own profile (name/nation); points/streak are server-authoritative.
      case "sync": squad = await syncMember(b.code, b.userId, b.patch || {}); break;
      default: return NextResponse.json({ error: "bad action" }, { status: 400 });
    }
    if (!squad) return NextResponse.json({ error: "squad not found" }, { status: 404 });
    return NextResponse.json({ squad });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
