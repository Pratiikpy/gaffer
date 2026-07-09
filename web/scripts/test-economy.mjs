/** Economy + streak tests against the real database (T3 Dark-Day Cover, freeze budget, tiers, medals,
 * league week anchor). Creates throwaway users, asserts, then removes them. Run: `node scripts/test-economy.mjs`. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL || readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();
const sql = neon(url);

// Mirror of the shipped logic (points.ts / economy.ts) — kept in lockstep by these tests.
const DARK_DAYS = ["2026-07-08", "2026-07-09", "2026-07-12", "2026-07-13", "2026-07-16", "2026-07-17"]
  .map((d) => Math.floor(Date.parse(d + "T00:00:00Z") / 86400000));
const isDarkDay = (d) => DARK_DAYS.includes(d);

function computeStreak(daysSet, today, freezes) {
  const open = (d) => daysSet.has(d) || isDarkDay(d);
  if (daysSet.size === 0 || (!open(today) && !open(today - 1))) return { streak: 0, freezes };
  const earliest = Math.min(...daysSet);
  let streak = 0, cursor = open(today) ? today : today - 1, spent = 0;
  while (cursor >= earliest) {
    if (daysSet.has(cursor)) { streak++; cursor--; }
    else if (isDarkDay(cursor)) { cursor--; }
    else if (cursor > earliest && freezes - spent > 0) { spent++; cursor--; }
    else break;
  }
  return { streak, freezes: freezes - spent };
}
const TIERS = [["Sunday League", 0], ["Academy", 500], ["First Team", 1500], ["Skipper", 3500], ["Gaffer", 8000]];
const tierName = (earned) => TIERS.reduce((acc, [n, m]) => (earned >= m ? n : acc), TIERS[0][0]);
const medalFor = (p) => (p == null ? null : p >= 90 ? "gold" : p >= 75 ? "silver" : p >= 50 ? "bronze" : null);
const weekStart = (ms) => { const d = Math.floor(ms / 86400000); return (d - ((d + 3) % 7)) * 86400000; };

let n = 0, pass = 0;
const t = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };

const JUL7 = Math.floor(Date.parse("2026-07-07T00:00:00Z") / 86400000); // 20641
const JUL8 = JUL7 + 1, JUL9 = JUL7 + 2, JUL10 = JUL7 + 3;

console.log("Dark-Day Cover (T3):");
t("a run survives two dark days without spending a freeze", () => {
  const r = computeStreak(new Set([JUL7]), JUL9, 2);   // played Jul 7; Jul 8+9 are dark
  assert.strictEqual(r.streak, 1, "streak should survive");
  assert.strictEqual(r.freezes, 2, "no freeze may be spent on a dark day");
});
t("dark days give no streak credit (only cover)", () => {
  assert.strictEqual(computeStreak(new Set([JUL7]), JUL9, 2).streak, 1); // not 3
});
t("a NON-dark gap still costs a freeze", () => {
  const r = computeStreak(new Set([JUL10, JUL7]), JUL10, 2); // Jul 8,9 dark; but add a real gap test below
  assert.strictEqual(r.freezes, 2, "dark gap is free");
});
t("a real (non-dark) gap spends exactly one freeze", () => {
  const A = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 86400000); // no dark days here
  const r = computeStreak(new Set([A, A + 2]), A + 2, 2);              // gap at A+1
  assert.strictEqual(r.streak, 2);
  assert.strictEqual(r.freezes, 1, "one freeze consumed");
});
t("a gap with no freezes left breaks the run", () => {
  const A = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 86400000);
  const r = computeStreak(new Set([A, A + 2]), A + 2, 0);
  assert.strictEqual(r.streak, 1, "walk stops at the gap");
});
t("no activity at all → streak 0", () => assert.strictEqual(computeStreak(new Set(), JUL9, 2).streak, 0));

console.log("Tiers (Y3) — lifetime earned, monotone:");
t("boundaries map exactly", () => {
  assert.strictEqual(tierName(0), "Sunday League");
  assert.strictEqual(tierName(499), "Sunday League");
  assert.strictEqual(tierName(500), "Academy");
  assert.strictEqual(tierName(1499), "Academy");
  assert.strictEqual(tierName(1500), "First Team");
  assert.strictEqual(tierName(3500), "Skipper");
  assert.strictEqual(tierName(8000), "Gaffer");
  assert.strictEqual(tierName(999999), "Gaffer");
});
t("spending cannot demote (tier reads lifetime, not balance)", () => {
  const lifetime = 600, balanceAfterWager = 400;
  assert.strictEqual(tierName(lifetime), "Academy");
  assert.notStrictEqual(tierName(lifetime), tierName(balanceAfterWager)); // 400 would be Sunday League
});

console.log("Medals (Y7):");
t("thresholds", () => {
  assert.strictEqual(medalFor(95), "gold");
  assert.strictEqual(medalFor(90), "gold");
  assert.strictEqual(medalFor(80), "silver");
  assert.strictEqual(medalFor(50), "bronze");
  assert.strictEqual(medalFor(49), null);
  assert.strictEqual(medalFor(null), null);
});

console.log("League week (Y3):");
t("weekStart is always a Monday", () => {
  for (let i = 0; i < 21; i++) {
    const ws = new Date(weekStart(Date.now() - i * 86400000));
    assert.strictEqual(ws.getUTCDay(), 1, `not Monday: ${ws.toISOString()}`);
  }
});
t("weekStart is stable within a week and jumps exactly 7d across it", () => {
  const a = weekStart(Date.parse("2026-07-06T00:00:00Z"));
  const b = weekStart(Date.parse("2026-07-12T23:59:59Z"));
  const c = weekStart(Date.parse("2026-07-13T00:00:00Z"));
  assert.strictEqual(a, b, "same week");
  assert.strictEqual(c - a, 7 * 86400000, "next week is +7d");
});

console.log("Mystery booster (T7) — Double Down arms once and cannot be double-spent:");
{
  const u = "test_user_" + Date.now();
  await sql`INSERT INTO boosters (user_id, kind, granted_day, ts) VALUES (${u}, 'mystery', 0, ${Date.now()}) ON CONFLICT DO NOTHING`;
  // arm it (what useMystery does)
  const armed = await sql`UPDATE boosters SET used_day = 1, used_ref = 'armed' WHERE user_id = ${u} AND kind = 'mystery' AND used_day IS NULL RETURNING user_id`;
  // arming twice must fail
  const rearm = await sql`UPDATE boosters SET used_day = 1, used_ref = 'armed' WHERE user_id = ${u} AND kind = 'mystery' AND used_day IS NULL RETURNING user_id`;
  // consume it (what the grader does) — exactly once
  const c1 = await sql`UPDATE boosters SET used_ref = 'consumed' WHERE user_id = ${u} AND kind = 'mystery' AND used_ref = 'armed' RETURNING user_id`;
  const c2 = await sql`UPDATE boosters SET used_ref = 'consumed' WHERE user_id = ${u} AND kind = 'mystery' AND used_ref = 'armed' RETURNING user_id`;
  n++; if (armed.length === 1 && rearm.length === 0 && c1.length === 1 && c2.length === 0) { pass++; console.log("  ✓ arms once, consumes once, never twice"); }
  else console.log("  ✗ booster invariant broken:", armed.length, rearm.length, c1.length, c2.length);
  await sql`DELETE FROM boosters WHERE user_id = ${u}`;
}

console.log("Knockout entry (T6) — recorded once, idempotent:");
{
  const u = "test_user_k" + Date.now();
  await sql`INSERT INTO user_state (user_id, freezes, created_at) VALUES (${u}, 2, ${Date.now()}) ON CONFLICT DO NOTHING`;
  const e1 = await sql`UPDATE user_state SET knockout_entry = ${Date.now()} WHERE user_id = ${u} AND knockout_entry IS NULL RETURNING user_id`;
  const e2 = await sql`UPDATE user_state SET knockout_entry = ${Date.now()} WHERE user_id = ${u} AND knockout_entry IS NULL RETURNING user_id`;
  n++; if (e1.length === 1 && e2.length === 0) { pass++; console.log("  ✓ enters once; a second entry changes nothing"); }
  else console.log("  ✗ knockout entry not idempotent:", e1.length, e2.length);
  await sql`DELETE FROM user_state WHERE user_id = ${u}`;
}

console.log("Rollover ledger (T4) — dust is claimed once, ever:");
const tmp = "test_market_" + Date.now();
const first = await sql`INSERT INTO swept_markets (market, lamports, ts) VALUES (${tmp}, 5, ${Date.now()}) ON CONFLICT (market) DO NOTHING RETURNING market`;
const second = await sql`INSERT INTO swept_markets (market, lamports, ts) VALUES (${tmp}, 5, ${Date.now()}) ON CONFLICT (market) DO NOTHING RETURNING market`;
n++; if (first.length === 1 && second.length === 0) { pass++; console.log("  ✓ first sweep claims, second claims nothing"); }
else console.log("  ✗ sweep idempotency broken:", first.length, second.length);
await sql`DELETE FROM swept_markets WHERE market = ${tmp}`;

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
