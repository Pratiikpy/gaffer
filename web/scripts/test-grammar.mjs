/** The market grammar: everything a language model is allowed to produce, and everything it is not.
 *
 * This is the half of the market compiler that has to be right. The model proposes a predicate from a
 * fan's sentence; nothing it emits reaches the chain until it has been re-derived and re-checked here.
 * So this suite is written the way an adversary would: malformed shapes, unverified stats, absurd
 * numbers, the wrong comparison, and predicates that are already true.
 *
 * Mirrors src/lib/marketGrammar.ts. Run: `node scripts/test-grammar.mjs`
 */
let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const COMPARISON_GREATER_THAN = 0;
const PERIOD_FULL_MATCH = 4;
const MAX_THRESHOLD = 19;

const STAT_CATALOG = [
  { key: 1, side: "home", noun: "goals", verb: "to score", verified: true },
  { key: 2, side: "away", noun: "goals", verb: "to score", verified: true },
  { key: 3, side: "home", noun: "bookings", verb: "to be booked", verified: false },
  { key: 4, side: "away", noun: "bookings", verb: "to be booked", verified: false },
  { key: 5, side: "home", noun: "red cards", verb: "to be sent off", verified: false },
  { key: 6, side: "away", noun: "red cards", verb: "to be sent off", verified: false },
  { key: 7, side: "home", noun: "corners", verb: "to win a corner", verified: false },
  { key: 8, side: "away", noun: "corners", verb: "to win a corner", verified: false },
];
const statByKey = (k) => STAT_CATALOG.find((s) => s.key === k);

function validatePredicate(c) {
  if (typeof c !== "object" || c === null) return { ok: false, reason: "No question I could read." };
  if (!Number.isInteger(c.statKey)) return { ok: false, reason: "I couldn't tell which stat that's about." };
  const stat = statByKey(c.statKey);
  if (!stat) return { ok: false, reason: "I can't settle that from the match data." };
  if (!stat.verified) return { ok: false, reason: `I can only settle goals right now — ${stat.noun} aren't confirmed in the feed yet.` };
  if (!Number.isInteger(c.threshold)) return { ok: false, reason: "I couldn't pin down a number for that." };
  if (c.threshold < 0) return { ok: false, reason: "That number can't be negative." };
  if (c.threshold > MAX_THRESHOLD) return { ok: false, reason: "That's beyond anything a match will produce." };
  if (c.comparison !== undefined && c.comparison !== COMPARISON_GREATER_THAN) return { ok: false, reason: "I can only run 'more than' questions." };
  return { ok: true, predicate: { statKey: stat.key, threshold: c.threshold, comparison: COMPARISON_GREATER_THAN, period: PERIOD_FULL_MATCH, stat } };
}
function questionFor(p, team) {
  const atLeast = p.threshold + 1;
  return atLeast === 1 ? `${team} ${p.stat.verb}?` : `${team} to score ${atLeast}+ ${p.stat.noun}?`;
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

console.log("unverified stats are refused, and say why:");
{
  for (const key of [3, 4, 5, 6, 7, 8]) {
    const r = ok({ statKey: key, threshold: 0 });
    t(`key ${key} (${statByKey(key).noun}) is refused until the feed is confirmed`, !r.ok);
  }
  const corners = ok({ statKey: 7, threshold: 8 });
  t("the refusal names the stat rather than blaming the fan", !corners.ok && corners.reason.includes("corners"));
  t("every verified stat is a goal stat", STAT_CATALOG.filter((s) => s.verified).every((s) => s.noun === "goals"));
  t("exactly two stats are verified today", STAT_CATALOG.filter((s) => s.verified).length === 2);
}

console.log("the question text comes from the number, never from the model's prose:");
{
  const one = ok({ statKey: 1, threshold: 0 }).predicate;
  const three = ok({ statKey: 2, threshold: 2 }).predicate;
  t("threshold 0 reads as 'to score'", questionFor(one, "USA") === "USA to score?");
  t("threshold 2 reads as '3+ goals' (the chain proves value > 2)", questionFor(three, "Belgium") === "Belgium to score 3+ goals?");
  t("home predicates name the home team", questionFor(one, "USA").startsWith("USA"));
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
