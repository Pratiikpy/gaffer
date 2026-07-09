/** Idempotent schema migration for GAFFER's hosted Postgres (Neon).
 * Safe to re-run: every statement is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 * Run: `npm run migrate` (reads DATABASE_URL from .env.local or the environment). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim(); }
  catch { throw new Error("DATABASE_URL not set and .env.local has none"); }
}
const sql = neon(dbUrl());

const statements = [
  // T3 — Streak Wager: stake points that a run survives N matchdays.
  `CREATE TABLE IF NOT EXISTS streak_wager (
     user_id text PRIMARY KEY,
     start_day int NOT NULL,
     target_days int NOT NULL DEFAULT 7,
     stake int NOT NULL DEFAULT 200,
     payout int NOT NULL DEFAULT 400,
     status text NOT NULL DEFAULT 'open',   -- open | won | lost
     ts bigint NOT NULL
   )`,

  // T4 — Rollover headline pot: real lamports left behind by settled pools, carried to the next day.
  `CREATE TABLE IF NOT EXISTS rollover (
     day int PRIMARY KEY,
     lamports bigint NOT NULL DEFAULT 0,
     sources int NOT NULL DEFAULT 0,
     ts bigint NOT NULL
   )`,

  // T7 / L8 — power-ups: the Mystery booster slot, and the one-per-matchday stick-or-twist move.
  `CREATE TABLE IF NOT EXISTS boosters (
     user_id text NOT NULL,
     kind text NOT NULL,                     -- mystery | stick_or_twist
     granted_day int NOT NULL,
     used_day int,
     used_ref text,
     ts bigint NOT NULL,
     PRIMARY KEY (user_id, kind, granted_day)
   )`,

  // S6 — Fade Duels: a persistent, named head-to-head ledger (was localStorage-only).
  `CREATE TABLE IF NOT EXISTS duels (
     id bigserial PRIMARY KEY,
     squad_code text NOT NULL,
     a_user text NOT NULL, a_name text NOT NULL, a_side text NOT NULL,
     b_user text NOT NULL, b_name text NOT NULL, b_side text NOT NULL,
     market text NOT NULL,
     question text NOT NULL DEFAULT '',
     status text NOT NULL DEFAULT 'live',    -- live | settled
     winner text,                            -- a_user | b_user | 'void'
     ts bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS duels_squad_idx ON duels (squad_code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS duels_unique_pair ON duels (squad_code, market, a_user, b_user)`,

  // C6 / C1 — every settled win, recorded once at claim: powers the biggest-wins feed and the
  // Proof-of-Payout v2 hero pair (stake → payout) and "settled Ns after full-time".
  `CREATE TABLE IF NOT EXISTS wins (
     sig text PRIMARY KEY,
     user_id text NOT NULL,
     name text NOT NULL DEFAULT '',
     fixture_id bigint NOT NULL DEFAULT 0,
     market text NOT NULL DEFAULT '',
     question text NOT NULL DEFAULT '',
     stake_lamports bigint NOT NULL DEFAULT 0,
     payout_lamports bigint NOT NULL DEFAULT 0,
     called_at int,                          -- consensus % when the call was locked (the 12% Stamp)
     settled_after_ms bigint,                -- ms between full-time and settlement
     ts bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS wins_payout_idx ON wins (payout_lamports DESC)`,

  // A money card must never say "Home v Away" (the app's own labels have to be true). The live TxLINE
  // snapshot only covers the current slate, so every fixture name we ever see is remembered here and
  // joined onto /api/markets — a pool on last week's match still shows the real teams.
  `CREATE TABLE IF NOT EXISTS fixture_names (
     fixture_id bigint PRIMARY KEY,
     home text NOT NULL,
     away text NOT NULL,
     ts bigint NOT NULL
   )`,

  // C1 — "settled N seconds after full-time": recorded the moment the kernel settles, from the proof's
  // own match timestamp. The brag stat no rival can print, so it has to come from the proof, not a guess.
  `CREATE TABLE IF NOT EXISTS settles (
     market text PRIMARY KEY,
     fixture_id bigint NOT NULL DEFAULT 0,
     match_ts bigint NOT NULL DEFAULT 0,      -- last proven event time (≈ full-time)
     settled_after_ms bigint NOT NULL DEFAULT 0,
     ts bigint NOT NULL
   )`,

  // T4 — a market's dust is swept into the rollover pot exactly once, ever. Without this the pot
  // double-counts on every sweep and stops being a real number.
  `CREATE TABLE IF NOT EXISTS swept_markets (
     market text PRIMARY KEY,
     lamports bigint NOT NULL,
     ts bigint NOT NULL
   )`,

  // T3 — milestones already hit, so a streak card mints exactly once per milestone.
  `CREATE TABLE IF NOT EXISTS milestones (
     user_id text NOT NULL,
     days int NOT NULL,
     ts bigint NOT NULL,
     PRIMARY KEY (user_id, days)
   )`,

  // T1/S1 — the consensus stamp captured at lock, server-side, from the TxLINE odds snapshot.
  `CREATE TABLE IF NOT EXISTS stamps (
     user_id text NOT NULL,
     market text NOT NULL,
     side text NOT NULL,
     called_at int NOT NULL,                 -- implied % the crowd/market gave YOUR side at lock
     message_id text,                        -- TxLINE MessageId of the snapshot that proves it
     as_of bigint,
     ts bigint NOT NULL,
     PRIMARY KEY (user_id, market)
   )`,
];

let ok = 0;
for (const s of statements) {
  await sql.query(s);
  ok++;
}
const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`;
console.log(`migrate: ${ok} statements applied`);
console.log("tables:", t.map((r) => r.table_name).join(", "));
