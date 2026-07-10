/** The market grammar: everything a language model is allowed to produce, and everything it is not.
 *
 * This is the half of the market compiler that has to be right. The model proposes a predicate from a
 * fan's sentence; nothing it emits reaches the chain until it has been re-derived and re-checked here.
 * So this suite is written the way an adversary would: malformed shapes, unverified stats, absurd
 * numbers, the wrong comparison, and predicates that are already true.
 *
 * Mirrors src/lib/marketGrammar.ts. Run: `node scripts/test-grammar.mjs`
 */
import { readFileSync } from "node:fs";

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const COMPARISON_GREATER_THAN = 0;
const PERIOD_FULL_MATCH = 4;
const MAX_THRESHOLD = 19;

const STAT_CATALOG = [
  { key: 1, side: "home", noun: "goals", verb: "to score", countVerb: "to score", verified: true },
  { key: 2, side: "away", noun: "goals", verb: "to score", countVerb: "to score", verified: true },
  { key: 3, side: "home", noun: "yellow cards", verb: "to be booked", countVerb: "to pick up", verified: true },
  { key: 4, side: "away", noun: "yellow cards", verb: "to be booked", countVerb: "to pick up", verified: true },
  { key: 5, side: "home", noun: "red cards", verb: "to be sent off", countVerb: "to be shown", verified: true },
  { key: 6, side: "away", noun: "red cards", verb: "to be sent off", countVerb: "to be shown", verified: true },
  { key: 7, side: "home", noun: "corners", verb: "to win a corner", countVerb: "to win", verified: true },
  { key: 8, side: "away", noun: "corners", verb: "to win a corner", countVerb: "to win", verified: true },
];
const statByKey = (k) => STAT_CATALOG.find((s) => s.key === k);

/** An unverified stat, to exercise the refusal that guards a key we cannot stand behind. The catalog has
 *  none today — every key the feed exposes has been reconciled — so the test supplies its own. */
const UNVERIFIED = { key: 42, side: "home", noun: "shots on target", verb: "to shoot", countVerb: "to take", verified: false };

function validatePredicate(c) {
  if (typeof c !== "object" || c === null) return { ok: false, reason: "No question I could read." };
  if (!Number.isInteger(c.statKey)) return { ok: false, reason: "I couldn't tell which stat that's about." };
  const stat = c.statKey === UNVERIFIED.key ? UNVERIFIED : statByKey(c.statKey);
  if (!stat) return { ok: false, reason: "I can't settle that from the match data." };
  if (!stat.verified) return { ok: false, reason: `I can't settle ${stat.noun} yet — the match data doesn't confirm them.` };
  if (!Number.isInteger(c.threshold)) return { ok: false, reason: "I couldn't pin down a number for that." };
  if (c.threshold < 0) return { ok: false, reason: "That number can't be negative." };
  if (c.threshold > MAX_THRESHOLD) return { ok: false, reason: "That's beyond anything a match will produce." };
  if (c.comparison !== undefined && c.comparison !== COMPARISON_GREATER_THAN) return { ok: false, reason: "I can only run 'more than' questions." };
  return { ok: true, predicate: { statKey: stat.key, threshold: c.threshold, comparison: COMPARISON_GREATER_THAN, period: PERIOD_FULL_MATCH, stat } };
}
function questionFor(p, team) {
  const atLeast = p.threshold + 1;
  return atLeast === 1 ? `${team} ${p.stat.verb}?` : `${team} ${p.stat.countVerb} ${atLeast}+ ${p.stat.noun}?`;
}
const isAlreadyTrue = (currentValue, threshold) => currentValue > threshold;

const ok = (c) => validatePredicate(c);

console.log("what the kernel accepts:");
{
  const r = ok({ statKey: 1, threshold: 0 });
  t("home goals over zero is legal", r.ok);
  t("it always compiles to GreaterThan", r.ok && r.predicate.comparison === COMPARISON_GREATER_THAN);
  t("and to the full-match period every other pool uses", r.ok && r.predicate.period === PERIOD_FULL_MATCH);
  t("away goals are legal too", ok({ statKey: 2, threshold: 2 }).ok);
  t("an explicit GreaterThan is accepted", ok({ statKey: 1, threshold: 1, comparison: 0 }).ok);
  t("threshold at the ceiling is legal", ok({ statKey: 1, threshold: MAX_THRESHOLD }).ok);
}

console.log("what it refuses — a model cannot talk its way past this:");
{
  t("a stat that isn't in the catalog", !ok({ statKey: 99, threshold: 0 }).ok);
  t("stat key 0", !ok({ statKey: 0, threshold: 0 }).ok);
  t("a period-multiplied key it invented (1001)", !ok({ statKey: 1001, threshold: 0 }).ok);
  t("LessThan", !ok({ statKey: 1, threshold: 0, comparison: 1 }).ok);
  t("EqualTo", !ok({ statKey: 1, threshold: 0, comparison: 2 }).ok);
  t("a negative threshold", !ok({ statKey: 1, threshold: -1 }).ok);
  t("an absurd threshold", !ok({ statKey: 1, threshold: 500 }).ok);
  t("a fractional threshold", !ok({ statKey: 1, threshold: 1.5 }).ok);
  t("a stringly-typed threshold", !ok({ statKey: 1, threshold: "2" }).ok);
  t("a stringly-typed stat key", !ok({ statKey: "1", threshold: 0 }).ok);
  t("NaN", !ok({ statKey: 1, threshold: NaN }).ok);
  t("Infinity", !ok({ statKey: 1, threshold: Infinity }).ok);
  t("null", !ok(null).ok);
  t("a bare string", !ok("USA to score").ok);
  t("an empty object", !ok({}).ok);
  t("a missing threshold", !ok({ statKey: 1 }).ok);
}

console.log("the eight keys the feed exposes are all settleable:");
{
  // scripts/verify-stat-keys.mjs reconciles each of these against the feed: the `Score` block names goals
  // and corners outright, and the card counts come from the event stream. Nothing here is presumed.
  for (const key of [1, 2, 3, 4, 5, 6, 7, 8]) {
    t(`key ${key} (${statByKey(key).noun}) settles`, ok({ statKey: key, threshold: 0 }).ok);
  }
  t("cards and corners are on the menu, not just goals",
    STAT_CATALOG.filter((s) => s.verified).some((s) => s.noun === "corners"));
}

console.log("an unverified stat is still refused, and says why:");
{
  const r = ok({ statKey: UNVERIFIED.key, threshold: 2 });
  t("a stat the feed has not confirmed cannot settle money", !r.ok);
  t("the refusal names the stat rather than blaming the fan", !r.ok && r.reason.includes("shots on target"));
}

console.log("the question text comes from the number, never from the model's prose:");
{
  const one = ok({ statKey: 1, threshold: 0 }).predicate;
  const three = ok({ statKey: 2, threshold: 2 }).predicate;
  t("threshold 0 reads as 'to score'", questionFor(one, "USA") === "USA to score?");
  t("threshold 2 reads as '3+ goals' (the chain proves value > 2)", questionFor(three, "Belgium") === "Belgium to score 3+ goals?");
  t("home predicates name the home team", questionFor(one, "USA").startsWith("USA"));

  // A count needs its own verb: "Spain to be booked 3+ yellow cards" is not a sentence a fan would utter.
  const booked = ok({ statKey: 3, threshold: 0 }).predicate;
  const bookings = ok({ statKey: 3, threshold: 2 }).predicate;
  const corner = ok({ statKey: 7, threshold: 0 }).predicate;
  const corners = ok({ statKey: 8, threshold: 4 }).predicate;
  const off = ok({ statKey: 6, threshold: 0 }).predicate;
  t("one booking reads as 'to be booked'", questionFor(booked, "Spain") === "Spain to be booked?");
  t("several read as 'to pick up 3+ yellow cards'", questionFor(bookings, "Spain") === "Spain to pick up 3+ yellow cards?");
  t("one corner reads as 'to win a corner'", questionFor(corner, "Spain") === "Spain to win a corner?");
  t("several read as 'to win 5+ corners'", questionFor(corners, "Belgium") === "Belgium to win 5+ corners?");
  t("a red card reads as 'to be sent off'", questionFor(off, "Belgium") === "Belgium to be sent off?");
}

console.log("the mirror above still matches the real catalog:");
{
  // This file re-implements src/lib/marketGrammar.ts so it can run under bare node. That is only honest
  // while the two agree — a flag flipped in one and not the other would test nothing.
  const src = readFileSync(new URL("../src/lib/marketGrammar.ts", import.meta.url), "utf8");
  for (const s of STAT_CATALOG) {
    const line = src.match(new RegExp(`\\{ key: ${s.key},[^}]*\\}`))?.[0] ?? "";
    t(`key ${s.key} agrees with the source`,
      line.includes(`noun: "${s.noun}"`) && line.includes(`countVerb: "${s.countVerb}"`) && line.includes(`verified: ${s.verified}`),
      line);
  }
}

console.log("a pool is never minted on something that already happened:");
{
  // USA are 2-0 up. "USA to score" (threshold 0) is already true — minting it hands a free pot to whoever
  // joins first. The model cannot know the live score; the server checks the feed.
  t("USA to score, at 2-0, is already true", isAlreadyTrue(2, 0));
  t("USA to score 3+, at 2-0, is still open", !isAlreadyTrue(2, 2));
  t("USA to score 2+, at 2-0, is already true", isAlreadyTrue(2, 1));
  t("a goalless match leaves 'to score' open", !isAlreadyTrue(0, 0));
  t("the boundary is strict: value == threshold is NOT yet true", !isAlreadyTrue(2, 2));
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
