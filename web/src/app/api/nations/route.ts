import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Real nation standings: sum each player's points by the nation they fly. Honest — the numbers move
 * as people earn points, and only nations that actually have players appear. The client renders each
 * nation with the drawn flag-icons SVG (the <Flag> component, keyed on name), never an emoji. */
export async function GET() {
  try {
    const rows = await db()`
      SELECT m.nation AS nation,
             COUNT(DISTINCT m.user_id)::int AS fans,
             COALESCE(SUM(p.total), 0)::int AS pts
      FROM (SELECT DISTINCT squad_code, user_id, nation FROM members) m
      LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM points_events e WHERE e.user_id = m.user_id) p ON TRUE
      GROUP BY m.nation
      ORDER BY pts DESC, fans DESC
      LIMIT 24`;
    const nations = (rows as any[]).map((r) => ({ name: r.nation, pts: Number(r.pts), fans: Number(r.fans) }));
    return NextResponse.json({ nations });
  } catch {
    return NextResponse.json({ nations: [] });
  }
}
