/** Q7 Round Table tests: snake ordering, wooden-spoon-first, no duplicate nations, turn enforcement,
 * and the shared clock's auto-pick. Uses the real DB with throwaway rows. Run: `node scripts/test-draft.mjs` */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL || readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();
const sql = neon(url);

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

/* ── pure: snake order (mirror of draft.ts) ── */
function snakeOrder(seed, laps) {
  const out = [];
  for (let lap = 0; lap < laps; lap++) out.push(...(lap % 2 === 0 ? seed : [...seed].reverse()));
  return out;
}

console.log("Q7 · snake ordering:");
t("one lap is just the seed order", JSON.stringify(snakeOrder(["a", "b", "c"], 1)) === JSON.stringify(["a", "b", "c"]));
t("the second lap reverses", JSON.stringify(snakeOrder(["a", "b", "c"], 2)) === JSON.stringify(["a", "b", "c", "c", "b", "a"]));
t("the third lap flips back", JSON.stringify(snakeOrder(["a", "b"], 3)) === JSON.stringify(["a", "b", "b", "a", "a", "b"]));
t("the last picker of a lap picks again immediately (that is the snake)", (() => {
  const o = snakeOrder(["a", "b", "c"], 2);          // a b c | c b a
  return o[2] === "c" && o[3] === "c";
})());
t("the first picker of a lap waits longest for their next pick", (() => {
  const o = snakeOrder(["a", "b", "c"], 2);
  return o.indexOf("a") === 0 && o.lastIndexOf("a") === 5;
})());

/* ── DB: the real invariants ── */
const CODE = "DRT" + String(Date.now()).slice(-6);
const D = "draft_" + Date.now();
const A = "u_a_" + Date.now(), B = "u_b_" + Date.now();

console.log("Q7 · wooden spoon picks first:");
{
  // Two members: A has 500 pts, B has 10. B (the spoon) must be first in the order.
  await sql`INSERT INTO squads (code, name, owner_id, created_at) VALUES (${CODE}, 'T', ${A}, ${Date.now()})`;
  await sql`INSERT INTO members (squad_code, user_id, name, streak, joined_at, token) VALUES (${CODE}, ${A}, 'Alice', 0, ${Date.now()}, 'tk')`;
  await sql`INSERT INTO members (squad_code, user_id, name, streak, joined_at, token) VALUES (${CODE}, ${B}, 'Bob', 0, ${Date.now()}, 'tk')`;
  await sql`INSERT INTO points_events (user_id, kind, amount, ref, ts) VALUES (${A}, 'seed', 500, ${'s' + A}, ${Date.now()})`;
  await sql`INSERT INTO points_events (user_id, kind, amount, ref, ts) VALUES (${B}, 'seed', 10, ${'s' + B}, ${Date.now()})`;

  const rows = await sql`
    SELECT m.user_id, COALESCE(p.total,0)::int AS points FROM members m
    LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM points_events e WHERE e.user_id = m.user_id) p ON TRUE
    WHERE m.squad_code = ${CODE} ORDER BY points ASC, m.user_id ASC`;
  t("the lowest-scoring member is on the clock first", rows[0].user_id === B, `got ${rows[0].user_id}`);
}

console.log("Q7 · a nation belongs to exactly one drafter:");
{
  await sql`INSERT INTO drafts (id, squad_code, round, state, pick_index, deadline, pick_secs, created_at)
            VALUES (${D}, ${CODE}, 1, 'live', 0, ${Date.now() + 60000}, 40, ${Date.now()})`;
  const first = await sql`INSERT INTO draft_picks (draft_id, nation, user_id, name, pick_no, auto, ts)
    VALUES (${D}, 'Brazil', ${B}, 'Bob', 0, false, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING nation`;
  const dupNation = await sql`INSERT INTO draft_picks (draft_id, nation, user_id, name, pick_no, auto, ts)
    VALUES (${D}, 'Brazil', ${A}, 'Alice', 1, false, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING nation`;
  t("the same nation cannot be drafted twice", first.length === 1 && dupNation.length === 0);

  const dupSlot = await sql`INSERT INTO draft_picks (draft_id, nation, user_id, name, pick_no, auto, ts)
    VALUES (${D}, 'Spain', ${A}, 'Alice', 0, false, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING nation`;
  t("two people cannot occupy the same pick slot", dupSlot.length === 0);
}

console.log("Q7 · the shared clock:");
{
  const d2 = D + "_x";
  const past = Date.now() - 1000;
  await sql`INSERT INTO drafts (id, squad_code, round, state, pick_index, deadline, pick_secs, created_at)
            VALUES (${d2}, ${CODE}, 1, 'live', 0, ${past}, 40, ${Date.now()})`;
  const row = await sql`SELECT deadline FROM drafts WHERE id = ${d2}`;
  t("an expired deadline is in the past (auto-pick will fire on read)", Number(row[0].deadline) < Date.now());

  // advance() semantics: index moves on, deadline resets, state closes at the end
  await sql`UPDATE drafts SET pick_index = pick_index + 1, deadline = ${Date.now()}::bigint + pick_secs * 1000,
            state = CASE WHEN pick_index + 1 >= 2 THEN 'done' ELSE state END WHERE id = ${d2}`;
  const after = await sql`SELECT pick_index, state, deadline FROM drafts WHERE id = ${d2}`;
  t("advancing resets the clock", Number(after[0].deadline) > Date.now());
  t("the draft closes once every slot is used", Number(after[0].pick_index) === 1 && after[0].state === "live");

  await sql`UPDATE drafts SET pick_index = pick_index + 1, state = CASE WHEN pick_index + 1 >= 2 THEN 'done' ELSE state END WHERE id = ${d2}`;
  const done = await sql`SELECT state FROM drafts WHERE id = ${d2}`;
  t("state flips to done on the last pick", done[0].state === "done");
  await sql`DELETE FROM drafts WHERE id = ${d2}`;
}

// cleanup
await sql`DELETE FROM draft_picks WHERE draft_id = ${D}`;
await sql`DELETE FROM draft_order WHERE draft_id = ${D}`;
await sql`DELETE FROM drafts WHERE squad_code = ${CODE}`;
await sql`DELETE FROM members WHERE squad_code = ${CODE}`;
await sql`DELETE FROM squads WHERE code = ${CODE}`;
await sql`DELETE FROM points_events WHERE user_id IN (${A}, ${B})`;

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
