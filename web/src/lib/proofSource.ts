import "server-only";
import { txline } from "@/lib/txline";
import { db } from "@/lib/db";

/** Find a REAL signed TxLINE proof whose stat is > 0 for a given fixture (sampling across the match). */
async function findProof(fixtureId: number, statKey: number): Promise<{ seq: number; bundle: any } | null> {
  const events = await txline().historicalEvents(fixtureId);
  const seqs = [...new Set(events.map((e: any) => Number(e.seq ?? e.Seq)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!seqs.length) return null;
  const idxs = [...new Set(Array.from({ length: 24 }, (_, k) => Math.floor((seqs.length - 1) * (k / 23))))];
  for (const i of idxs) {
    const b = await txline().statValidation(fixtureId, seqs[i], statKey);
    if (b && Number(b?.statToProve?.value) > 0) return { seq: seqs[i], bundle: b };
  }
  return null;
}

let cache: { at: number; v: { fixtureId: number; statKey: number; seq: number; bundle: any } } | null = null;
const TTL = 3 * 60_000;

/**
 * Self-healing anchored-proof source: tries the requested fixture, then the most recent finished
 * fixtures we've seen, until one still verifies against `daily_scores_roots`. Cached (no-arg case).
 */
export async function fetchAnchoredProof(wanted = 0, statKey = 1): Promise<{ fixtureId: number; statKey: number; seq: number; bundle: any } | null> {
  if (!wanted && cache && Date.now() - cache.at < TTL) return cache.v;
  const rows = await db()`SELECT fixture_id FROM fixture_names ORDER BY fixture_id DESC LIMIT 12`.catch(() => []);
  const recent = (rows as any[]).map((r) => Number(r.fixture_id));
  const candidates = [...new Set([wanted, ...recent].filter(Boolean))];
  for (const fx of candidates) {
    const found = await findProof(fx, statKey).catch(() => null);
    if (found) {
      const v = { fixtureId: fx, statKey, seq: found.seq, bundle: found.bundle };
      if (!wanted) cache = { at: Date.now(), v };
      return v;
    }
  }
  return null;
}
