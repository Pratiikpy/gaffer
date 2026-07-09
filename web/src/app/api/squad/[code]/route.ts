import { NextRequest, NextResponse } from "next/server";
import { getSquad } from "@/lib/squadStore";
import { squadSettings, listLore, listDuels, h2hRecord } from "@/lib/squadPlus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The squad a fan sees: members + feed, plus the commissioner's settings (Q9), the auto-named lore
 * wall (Q2), and this fan's Fade Duels with their standing head-to-head record (S6).
 * `?user=` scopes the duels to the caller; without it, only the public squad is returned. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = req.nextUrl.searchParams.get("user") || "";
  const sq = await getSquad(code);
  if (!sq) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [settings, lore, duels] = await Promise.all([
    squadSettings(code).catch(() => null),
    listLore(code).catch(() => []),
    user ? listDuels(code, user).catch(() => []) : Promise.resolve([]),
  ]);

  // Q9 — "hide picks until lock" has to be enforced HERE. Concealing a side in the UI while shipping it
  // in the response body is theatre: anyone can read the network tab. A call by someone else, on a pool
  // that has not reached its cut-off yet, goes out with no side and no reason at all.
  if (settings?.picksVisible === "after_lock") {
    const now = Date.now();
    sq.feed = sq.feed.map((f) => {
      const locked = f.lockTs != null && now >= f.lockTs;
      const conceal = (f.kind === "call" || f.kind === "shot") && f.userId !== user && !locked;
      if (!conceal) return f;
      const { side, reason, sealed, ...rest } = f;
      return { ...rest, reactions: f.reactions, concealed: true } as typeof f;
    });
  }

  // Attach the standing record to each duel, so the card can read "Dev leads Sam 7–4".
  const withRecords = await Promise.all(
    duels.map(async (d) => {
      const me = d.a.userId === user ? d.a : d.b;
      const them = d.a.userId === user ? d.b : d.a;
      const rec = await h2hRecord(code, me.userId, them.userId).catch(() => ({ x: 0, y: 0, draws: 0 }));
      return { ...d, me, them, record: { mine: rec.x, theirs: rec.y, draws: rec.draws } };
    }),
  );

  return NextResponse.json({ squad: sq, settings, lore, duels: withRecords });
}
