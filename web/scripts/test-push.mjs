/** K6 push-budget tests against the real ledger: the per-match cap, the dedupe, and the rule that a win
 * is never budgeted. Mirrors src/lib/push.ts `claimBudget`. Run: `node scripts/test-push.mjs` */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL || readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();
const sql = neon(url);

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const MAX_PER_MATCH = 4;
const U = "push_test_" + Date.now();

async function claimBudget(userId, scope, tag, cls) {
  const claimed = await sql`INSERT INTO push_log (user_id, scope, tag, class, ts)
    VALUES (${userId}, ${scope}, ${tag}, ${cls}, ${Date.now()})
    ON CONFLICT (user_id, tag) DO NOTHING RETURNING id`;
  if (!claimed.length) return false;
  if (cls === "A") return true;
  const used = await sql`SELECT COUNT(*)::int AS n FROM push_log WHERE user_id = ${userId} AND scope = ${scope} AND class = 'B'`;
  if (Number(used[0].n) <= MAX_PER_MATCH) return true;
  await sql`DELETE FROM push_log WHERE user_id = ${userId} AND tag = ${tag}`;
  return false;
}

console.log("K6 · the push budget:");
{
  const scope = "fixture:1";
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await claimBudget(U, scope, `beat:${i}`, "B"));
  t(`exactly ${MAX_PER_MATCH} budgeted pushes get through a match`, results.filter(Boolean).length === MAX_PER_MATCH, JSON.stringify(results));
  t("the ones over budget are refused, not queued", results[4] === false && results[5] === false);
}

console.log("K6 · dedupe:");
{
  const first = await claimBudget(U, "fixture:2", "same-beat", "B");
  const again = await claimBudget(U, "fixture:2", "same-beat", "B");
  t("the same beat is never sent twice", first === true && again === false);
}

console.log("K6 · a win is never budgeted:");
{
  const scope = "fixture:3";
  for (let i = 0; i < MAX_PER_MATCH; i++) await claimBudget(U, scope, `spend:${i}`, "B");
  const overB = await claimBudget(U, scope, "one-more-B", "B");
  const winA = await claimBudget(U, scope, "you-won", "A");
  t("class B is exhausted", overB === false);
  t("class A still gets through — nobody resents being told they got paid", winA === true);
}

console.log("K6 · budgets are per match, not global:");
{
  const other = await claimBudget(U, "fixture:9", "fresh-match", "B");
  t("a new match starts with a fresh budget", other === true);
}

console.log("K6 · budgets are per person:");
{
  const other = await claimBudget(U + "_b", "fixture:1", "beat:0", "B");
  t("another person's budget is untouched by yours", other === true);
  await sql`DELETE FROM push_log WHERE user_id = ${U + "_b"}`;
}

await sql`DELETE FROM push_log WHERE user_id = ${U}`;
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
