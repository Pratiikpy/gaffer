import { NextRequest, NextResponse } from "next/server";
import { authed } from "@/lib/squadStore";
import { isOwner } from "@/lib/squadPlus";
import { startDraft, liveDraft, makePick, boardNations } from "@/lib/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Q7 — the squad's Round Table. Reading it also advances the shared clock, so an abandoned turn is
 * auto-picked rather than freezing the room for everyone else. */
export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get("code") || "").toUpperCase();
  if (!code) return NextResponse.json({ error: "no squad" }, { status: 400 });
  const nations = await boardNations();
  const draft = await liveDraft(code, nations);
  return NextResponse.json({ draft, nations });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const code = String(b.code || "").toUpperCase();
    const userId = String(b.userId || "");
    if (!(await authed(code, userId, String(b.token || "")))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const nations = await boardNations();

    if (b.action === "start") {
      // Draft night is called by the person who runs the squad.
      if (!(await isOwner(code, userId))) return NextResponse.json({ error: "Only the squad owner can call the draft." }, { status: 403 });
      const draft = await startDraft(code, nations, Number(b.round) || 1);
      if (!draft) return NextResponse.json({ error: "A draft needs at least two people in the squad." }, { status: 400 });
      return NextResponse.json({ draft, nations });
    }

    if (b.action === "pick") {
      const draft = await liveDraft(code, nations);
      if (!draft) return NextResponse.json({ error: "No draft running." }, { status: 400 });
      const r = await makePick(draft.id, userId, String(b.nation || ""), nations);
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
      return NextResponse.json({ draft: r.draft, nations });
    }

    return NextResponse.json({ error: "bad action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
