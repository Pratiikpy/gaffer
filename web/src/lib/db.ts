/** Neon serverless Postgres client — the single hosted-DB entry point (K4).
 * Lazy so `next build` never needs DATABASE_URL at collection time; a route that actually
 * touches the DB fails loudly at request time if it's missing, rather than silently degrading. */
import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — the squad/points store needs a hosted Postgres (Neon).");
    _sql = neon(url);
  }
  return _sql;
}
