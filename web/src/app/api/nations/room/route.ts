import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { joinSquad } from "@/lib/squadStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Q6 — the empty-squad fallback.
 *
 * "ANY GROUPS that can send me an invite. None of the people I sent to are doing it." A fan who arrives
 * with no friends must still land in a room with people in it, or they leave. Every nation has one
 * public room; joining it is the same act as joining any squad, so the feed, the leaderboard and the
 * Frozen Window all work unchanged — it is a squad that happens to be open to everyone.
 *
 * It is owned by nobody in particular, so no stranger gets commissioner powers over the tribe.
 */
const codeFor = (nation: string) => ("N" + nation.replace(/[^A-Za-z]/g, "").toUpperCase()).slice(0, 6).padEnd(6, "X");

export async function POST(req: NextRequest) {
  try {
    const { nation, member } = await req.json();
    const n = String(nation || "").trim();
    if (!n || !member?.id) return NextResponse.json({ error: "missing nation/member" }, { status: 400 });

    const code = codeFor(n);
    const exists = await db()`SELECT code FROM squads WHERE code = ${code}`;
    if (!exists.length) {
      await db()`INSERT INTO squads (code, name, owner_id, created_at, is_nation_room)
                 VALUES (${code}, ${`${n} — the tribe`}, ${"nation_room"}, ${Date.now()}, TRUE)
                 ON CONFLICT (code) DO NOTHING`;
      await db()`INSERT INTO feed (id, squad_code, ts, user_id, name, kind, text)
                 VALUES (${"nr" + Date.now().toString(36)}, ${code}, ${Date.now()}, 'system', '', 'system', ${`The ${n} tribe opens.`})`;
    }

    const r = await joinSquad(code, { ...member, nation: n });
    if (!r) return NextResponse.json({ error: "couldn't open the room" }, { status: 500 });
    return NextResponse.json({ ...r, isNationRoom: true });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
