/** The legal shape of a market, and the only thing a model is ever allowed to produce.
 *
 * The kernel accepts a single predicate and nothing else:
 *
 *     stat[key] > threshold          (comparison must be GreaterThan; `settle` proves exactly this)
 *
 * That is a tiny, closed space, which is what makes a language model safe to point at it. The model
 * proposes; this grammar disposes. Nothing reaches the chain that has not been re-derived and re-checked
 * here, so the worst a bad completion can do is get refused.
 *
 * ── Where the catalog comes from ─────────────────────────────────────────────────────────────────────
 *
 * The feed's `Stats` block is period-multiplied: bare `1..8` alongside `1001..1008`, `2001..2008`, and
 * further zeroed blocks. TxLINE's docs confirm the shape ("every stat maps to a fixed cryptographic key
 * with period multipliers applied on top") but publish no table of what each stat *is*. The app used to
 * settle only goals, because they were the only keys that reproduced a known scoreline, and a guess is
 * not a thing to settle money on.
 *
 * The feed answers the question itself, twice over, and `scripts/verify-stat-keys.mjs` makes it do so:
 *
 *   - Every event names an `Action` ("goal", "yellow_card", "red_card", "corner") and a `Participant` —
 *     an index, 1 or 2, with `Participant1IsHome` saying which is which. De-duplicate by `Id`, drop the
 *     retracted, count per side, and compare against the final bare `Stats` block.
 *   - Independently, each event carries `Score.ParticipantN.Total` with `Goals` and `Corners` spelled out
 *     in plain English.
 *
 * Across four finished matches the `Score` block agrees with `Stats` on all eight goal and corner checks,
 * and the event counts agree on all eight card checks. (One corner count comes out one high on fixture
 * 18193785 — a retraction the reconstruction misses — which is a flaw in our counting, not in the
 * mapping the `Score` block confirms outright.) That is the whole catalog below, earned rather than
 * assumed.
 *
 * What is still *not* established is the period multipliers: on the 1–4 match, stat 1 reads full=1 with
 * first=1 and second=1, and stat 8 reads full=5 with first=3 and second=3 — neither additive nor
 * cumulative. We never use them. Every pool is a full-match predicate over a bare key.
 *
 * A stat we cannot stand behind lives here with `verified: false` and is refused by the validator.
 */

/** The kernel's only comparison: `require!(comparison == COMPARISON_GREATER_THAN)`. */
export const COMPARISON_GREATER_THAN = 0;

/** Cosmetic on-chain field. `settle` binds the stat key alone; the proof's `period` is the live
 *  game-phase at the snapshot, not the stat's scope. Every existing pool stores 4; so do ours. */
export const PERIOD_FULL_MATCH = 4;

/** Nobody is asking whether a team scores 21 goals, and an absurd threshold makes an unsettleable pool. */
export const MAX_THRESHOLD = 19;

export type Side = "home" | "away";

export type StatDef = {
  key: number;
  side: Side;
  /** Plural noun, as a fan says it: "goals". */
  noun: string;
  /** Verb phrase for the once-is-enough question: "Spain to score?", "Spain to be sent off?". */
  verb: string;
  /** Verb phrase when a count follows: "Spain to score 3+ goals?", "Spain to pick up 3+ yellow cards?".
   *  Distinct from `verb` because "to be booked 3+ yellow cards" is not a sentence. */
  countVerb: string;
  /** True only for a key reconciled against the feed by `scripts/verify-stat-keys.mjs`. Anything else is
   *  refused by `validatePredicate` — an unverified key is a guess, and a guess cannot settle money. */
  verified: boolean;
};

export const STAT_CATALOG: readonly StatDef[] = [
  { key: 1, side: "home", noun: "goals", verb: "to score", countVerb: "to score", verified: true },
  { key: 2, side: "away", noun: "goals", verb: "to score", countVerb: "to score", verified: true },
  // Keys 3-6 count `yellow_card` and `red_card` events. "Booked" is the yellow; a sending-off is its own
  // key, and the feed does not fold one into the other.
  { key: 3, side: "home", noun: "yellow cards", verb: "to be booked", countVerb: "to pick up", verified: true },
  { key: 4, side: "away", noun: "yellow cards", verb: "to be booked", countVerb: "to pick up", verified: true },
  { key: 5, side: "home", noun: "red cards", verb: "to be sent off", countVerb: "to be shown", verified: true },
  { key: 6, side: "away", noun: "red cards", verb: "to be sent off", countVerb: "to be shown", verified: true },
  { key: 7, side: "home", noun: "corners", verb: "to win a corner", countVerb: "to win", verified: true },
  { key: 8, side: "away", noun: "corners", verb: "to win a corner", countVerb: "to win", verified: true },
] as const;

export const statByKey = (key: number): StatDef | undefined => STAT_CATALOG.find((s) => s.key === key);
export const verifiedStats = (): StatDef[] => STAT_CATALOG.filter((s) => s.verified);

/** What a model is allowed to emit. `threshold` is the kernel's, not the fan's: `> threshold`. */
export type Predicate = { statKey: number; threshold: number };

/** A predicate the kernel will accept, with the exact arguments `create_market` takes. */
export type ValidPredicate = Predicate & {
  comparison: typeof COMPARISON_GREATER_THAN;
  period: typeof PERIOD_FULL_MATCH;
  stat: StatDef;
};

export type Refusal = { ok: false; reason: string };
export type Accepted = { ok: true; predicate: ValidPredicate };

/** The gate. Everything a model produces passes through here before it can cost anyone a lamport. */
export function validatePredicate(candidate: unknown): Accepted | Refusal {
  if (typeof candidate !== "object" || candidate === null) return { ok: false, reason: "No question I could read." };
  const c = candidate as Record<string, unknown>;

  if (!Number.isInteger(c.statKey)) return { ok: false, reason: "I couldn't tell which stat that's about." };
  const stat = statByKey(c.statKey as number);
  if (!stat) return { ok: false, reason: "I can't settle that from the match data." };
  if (!stat.verified) {
    return { ok: false, reason: `I can't settle ${stat.noun} yet — the match data doesn't confirm them.` };
  }

  if (!Number.isInteger(c.threshold)) return { ok: false, reason: "I couldn't pin down a number for that." };
  const threshold = c.threshold as number;
  if (threshold < 0) return { ok: false, reason: "That number can't be negative." };
  if (threshold > MAX_THRESHOLD) return { ok: false, reason: "That's beyond anything a match will produce." };

  // A model that hands back a comparison at all must hand back the only one that exists.
  if (c.comparison !== undefined && c.comparison !== COMPARISON_GREATER_THAN) {
    return { ok: false, reason: "I can only run 'more than' questions." };
  }

  return {
    ok: true,
    predicate: { statKey: stat.key, threshold, comparison: COMPARISON_GREATER_THAN, period: PERIOD_FULL_MATCH, stat },
  };
}

/** The fan-facing question, derived from the predicate — never from the model's prose.
 *
 * The chain settles `value > threshold`, so `threshold: 0` is "at least one" and `threshold: 2` is
 * "at least three". Rendering the model's own wording would let a mis-worded question sit above a
 * correctly-settling pool: the words and the money must come from the same number. */
export function questionFor(p: ValidPredicate, team: string): string {
  const atLeast = p.threshold + 1;
  if (atLeast === 1) return `${team} ${p.stat.verb}?`;
  return `${team} ${p.stat.countVerb} ${atLeast}+ ${p.stat.noun}?`;
}

/** Which team a predicate is about, given the fixture's names. */
export const teamFor = (p: ValidPredicate, home: string, away: string): string => (p.stat.side === "home" ? home : away);

/** A pool must not be created on something that has ALREADY happened.
 *
 * `settle` proves `value > threshold`, so a predicate whose current value already clears the threshold is
 * true the moment it is minted: the first person in takes a free pot from anyone who joins after. The
 * model cannot be trusted to know the live score, and it should not have to — the server checks the real
 * value against the feed before anything is created. */
export function isAlreadyTrue(currentValue: number, threshold: number): boolean {
  return currentValue > threshold;
}
