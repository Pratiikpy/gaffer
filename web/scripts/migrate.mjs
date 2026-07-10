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
  // T6 — the late-join promise: entering the knockout board is a first-class, recorded act.
  `ALTER TABLE user_state ADD COLUMN IF NOT EXISTS knockout_entry bigint`,

  // Q9 — commissioner tools. The organizer is the real customer: give them the controls and they bring
  // the other fourteen. Pick visibility is theirs to set; the prize note is theirs to write.
  `ALTER TABLE squads ADD COLUMN IF NOT EXISTS prize_note text`,
  // picks_visible: 'always' | 'after_lock'
  `ALTER TABLE squads ADD COLUMN IF NOT EXISTS picks_visible text NOT NULL DEFAULT 'always'`,
  `ALTER TABLE squads ADD COLUMN IF NOT EXISTS is_nation_room boolean NOT NULL DEFAULT false`,
  // Q9 proxy picks: a member the commissioner may call on behalf of ("my grandparents play").
  `ALTER TABLE members ADD COLUMN IF NOT EXISTS proxy_ok boolean NOT NULL DEFAULT false`,

  // S5 — a call can carry the reason it was made. Copy-a-Call is never a blind clone.
  `ALTER TABLE feed ADD COLUMN IF NOT EXISTS reason text`,
  // Q9 "see picks after lock" — the pool's own cut-off, stored with the call so the server can decide
  // when a pick may be revealed. Concealing only in the UI would leave the side in the response body.
  `ALTER TABLE feed ADD COLUMN IF NOT EXISTS lock_ts bigint`,

  // K6 — the push budget. A notification ledger, so "at most four pushes a match" is a fact the server
  // can enforce rather than a promise in a doc. 95% of push-silent opt-ins churn; so does everyone you
  // buzz about a match they have no stake in.
  // The TxLINE API token, shared across serverless instances.
  //
  // Authenticating is not cheap: guest JWT -> an on-chain `subscribe` transaction -> activate. Every
  // cold lambda was paying that in full, which made the first request to a fresh deployment slow enough
  // to fail (Hi-Lo answered 503 to the first visitor) and spent the server keypair's SOL on a fresh
  // subscribe each time. One token, reused, re-minted only when it stops working.
  `CREATE TABLE IF NOT EXISTS txline_token (
     id         INT PRIMARY KEY DEFAULT 1,
     token      TEXT NOT NULL,
     minted_at  BIGINT NOT NULL,
     CONSTRAINT txline_token_singleton CHECK (id = 1)
   )`,
  `CREATE TABLE IF NOT EXISTS push_log (
     id bigserial PRIMARY KEY,
     user_id text NOT NULL,
     scope text NOT NULL,               -- the match (or 'global') this push belongs to
     tag text NOT NULL,                 -- dedupe key: the same beat is never sent twice
     class text NOT NULL DEFAULT 'B',   -- A = you won (always allowed) | B = budgeted
     ts bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS push_log_user_scope_idx ON push_log (user_id, scope)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS push_log_dedupe ON push_log (user_id, tag)`,

  // Q7 — The Round Table: a per-round snake draft of surviving nations on a shared clock. Draft night
  // is what sustains a 25-year league; the dark days between rounds are dead air the product can own.
  `CREATE TABLE IF NOT EXISTS drafts (
     id text PRIMARY KEY,
     squad_code text NOT NULL,
     round int NOT NULL DEFAULT 1,
     state text NOT NULL DEFAULT 'live',      -- live | done
     pick_index int NOT NULL DEFAULT 0,       -- whose turn, as an index into draft_order
     deadline bigint NOT NULL,
     pick_secs int NOT NULL DEFAULT 40,
     created_at bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS drafts_squad_idx ON drafts (squad_code)`,
  `CREATE TABLE IF NOT EXISTS draft_order (
     draft_id text NOT NULL,
     pick_no int NOT NULL,
     user_id text NOT NULL,
     name text NOT NULL DEFAULT '',
     PRIMARY KEY (draft_id, pick_no)
   )`,
  `CREATE TABLE IF NOT EXISTS draft_picks (
     draft_id text NOT NULL,
     nation text NOT NULL,
     user_id text NOT NULL,
     name text NOT NULL DEFAULT '',
     pick_no int NOT NULL,
     auto boolean NOT NULL DEFAULT false,
     ts bigint NOT NULL,
     PRIMARY KEY (draft_id, nation)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_slot ON draft_picks (draft_id, pick_no)`,

  // Q2 — the lore wall. A moment is auto-named when it settles, and pinned forever.
  `CREATE TABLE IF NOT EXISTS lore (
     id bigserial PRIMARY KEY,
     squad_code text NOT NULL,
     round_id text,
     title text NOT NULL,
     detail text NOT NULL DEFAULT '',
     minute int,
     ts bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS lore_squad_idx ON lore (squad_code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lore_round_unique ON lore (round_id) WHERE round_id IS NOT NULL`,

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
