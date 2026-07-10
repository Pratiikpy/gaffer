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
 * ── Why the catalog is so short ──────────────────────────────────────────────────────────────────────
 *
 * The feed's `Stats` block is period-multiplied: bare `1..8` alongside `1001..1008`, `2001..2008`, and
 * further zeroed blocks. TxLINE's docs confirm the shape ("every stat maps to a fixed cryptographic key
 * with period multipliers applied on top") but publish no table of what each stat *is*.
 *
 * Two keys are established beyond doubt, because they reproduce known scorelines on two different
 * matches: fixture 18172379 (USA 2–0 Bosnia) reports key 1 = 2, key 2 = 0; fixture 18193785 (USA 1–4
 * Belgium) reports key 1 = 1, key 2 = 4. Those are home goals and away goals, full match.
 *
 * Nothing else reconciles. On the 1–4 match, stat 1 reads full=1 with first=1 and second=1, and stat 8
 * reads full=5 with first=3 and second=3 — neither additive nor cumulative. So the period variants, and
 * the identity of stats 3–8, remain unverified. Elsewhere the app *displays* keys 3/4 as bookings and 7/8
 * as corners; that is a guess we inherited, and a guess is not a thing to settle money on.
 *
 * Unverified stats therefore live in the catalog with `verified: false`, are refused by the validator,
 * and light up the day TxODDS publishes the table — by flipping one flag, not by rewriting anything.
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
  /** Verb phrase for the question: "to score". */
  verb: string;
  /** False until TxODDS confirms the stat-key table. Refused by `validatePredicate` while false. */
  verified: boolean;
};

export const STAT_CATALOG: readonly StatDef[] = [
  { key: 1, side: "home", noun: "goals", verb: "to score", verified: true },
  { key: 2, side: "away", noun: "goals", verb: "to score", verified: true },
  // Presumed from the app's existing display code, never confirmed against a published table or an
  // independent scoreline. Refused until they are.
  { key: 3, side: "home", noun: "bookings", verb: "to be booked", verified: false },
  { key: 4, side: "away", noun: "bookings", verb: "to be booked", verified: false },
  { key: 5, side: "home", noun: "red cards", verb: "to be sent off", verified: false },
  { key: 6, side: "away", noun: "red cards", verb: "to be sent off", verified: false },
  { key: 7, side: "home", noun: "corners", verb: "to win a corner", verified: false },
  { key: 8, side: "away", noun: "corners", verb: "to win a corner", verified: false },
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
    return { ok: false, reason: `I can only settle goals right now — ${stat.noun} aren't confirmed in the feed yet.` };
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
  return `${team} to score ${atLeast}+ ${p.stat.noun}?`;
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
