import { NextRequest, NextResponse } from "next/server";
import { createSquad, joinSquad, postMessage, recordCall, react, syncMember, authed } from "@/lib/squadStore";
import { createDuel, listDuels, kickMember, setProxy, setPicksVisible, setPrizeNote, squadSettings } from "@/lib/squadPlus";

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

    // ── S6 Fade Duels ──────────────────────────────────────────────────────────────────────────────
    if (b.action === "duel") {
      const d = await createDuel({
        squadCode: b.code, market: String(b.market || ""), question: String(b.q || ""),
        a: { userId: b.userId, name: String(b.name || "You"), side: Number(b.side) },
        b: { userId: String(b.targetId || ""), name: String(b.targetName || "Them"), side: Number(b.targetSide) },
      });
      if (!d) return NextResponse.json({ error: "That duel can't be made." }, { status: 400 });
      return NextResponse.json({ duel: d, duels: await listDuels(b.code, b.userId) });
    }
    if (b.action === "duels") return NextResponse.json({ duels: await listDuels(b.code, b.userId) });

    // ── Q9 Commissioner tools (owner-only, enforced server-side) ───────────────────────────────────
    if (b.action === "kick" || b.action === "proxy" || b.action === "visibility" || b.action === "prize") {
      let r: { ok: boolean; reason?: string };
      if (b.action === "kick") r = await kickMember(b.code, b.userId, String(b.targetId || ""));
      else if (b.action === "proxy") r = await setProxy(b.code, b.userId, String(b.targetId || ""), !!b.allow);
      else if (b.action === "visibility") r = await setPicksVisible(b.code, b.userId, b.mode === "after_lock" ? "after_lock" : "always");
      else r = await setPrizeNote(b.code, b.userId, String(b.note || ""));
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 403 });
      return NextResponse.json({ ok: true, settings: await squadSettings(b.code) });
    }

    let squad = null;
    switch (b.action) {
      case "post": squad = await postMessage(b.code, b.userId, b.name, b.text); break;
      // A recorded call may carry a sealed Called Shot line (item 15) and the written reason behind it
      // (S5 — Copy-a-Call is never a blind clone). Points are NEVER taken from the body.
      case "call": squad = await recordCall(b.code, b.userId, b.name, b.market, b.side, b.q, b.sealed, b.reason); break;
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
