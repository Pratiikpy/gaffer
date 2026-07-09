/** Durable fixture-name memory.
 *
 * The live TxLINE snapshot only carries the current slate, but pools outlive it: a market opened on
 * last week's match still has money in it and still has to say who played. Audit rule #7 — "the app's
 * own labels must be true" — so a money card may never fall back to "Home v Away". Every fixture we
 * ever see is remembered here, and `/api/markets` joins the names back on. */
import "server-only";
import { db } from "./db";

export type FixtureName = { home: string; away: string };

/** Remember every fixture in a snapshot. Cheap upsert; names don't change once a match exists. */
export async function rememberFixtures(list: { fixtureId: number | string; home?: string; away?: string; homeTeam?: string; awayTeam?: string }[]) {
  const rows = (list || [])
    .map((f) => ({ id: Number(f.fixtureId), home: f.home || f.homeTeam || "", away: f.away || f.awayTeam || "" }))
    .filter((f) => Number.isFinite(f.id) && f.id > 0 && f.home && f.away);
  if (!rows.length) return;
  const now = Date.now();
  // Neon's driver has no multi-row helper here; the slate is ~10 rows, so a small loop is fine.
  await Promise.all(rows.map((r) => db()`
    INSERT INTO fixture_names (fixture_id, home, away, ts) VALUES (${r.id}, ${r.home}, ${r.away}, ${now})
    ON CONFLICT (fixture_id) DO UPDATE SET home = EXCLUDED.home, away = EXCLUDED.away`));
}

/** Look up names for the given fixture ids. Missing ids simply don't appear in the map. */
export async function fixtureNames(ids: (number | string)[]): Promise<Record<string, FixtureName>> {
  const want = [...new Set(ids.map((i) => Number(i)).filter((i) => Number.isFinite(i) && i > 0))];
  if (!want.length) return {};
  const rows = await db()`SELECT fixture_id, home, away FROM fixture_names WHERE fixture_id = ANY(${want})`;
  const out: Record<string, FixtureName> = {};
  for (const r of rows as any[]) out[String(r.fixture_id)] = { home: r.home, away: r.away };
  return out;
}
