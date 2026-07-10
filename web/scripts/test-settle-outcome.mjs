/** What a settled market ACTUALLY resolved to.
 *
 * `settle` succeeding does not mean YES won. The kernel (latch/src/lib.rs, `pub fn settle`) proves the
 * predicate, then branches: if `yes_total == 0` there is no rightful winner, so it writes STATUS_VOID and
 * refunds both sides rather than trapping the pot in an unclaimable SETTLED_YES. The keeper must read the
 * status the chain wrote, not assume the happy path — otherwise it logs "YES" for a refunded pool and
 * settles every Fade Duel on that pool the wrong way.
 *
 * This is the exact case the keeper hit on its first live sweep: an empty pool proved true and voided.
 * Run: `node scripts/test-settle-outcome.mjs`
 */
let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const STATUS_OPEN = 0, STATUS_SETTLED_YES = 1, STATUS_VOID = 2;

/** The kernel's own branch, mirrored. */
function kernelSettle(market) {
  if (market.status !== STATUS_OPEN) throw new Error("not open");
  if (!market.predicateTrue) throw new Error("PredicateNotMet");
  return market.yesTotal === 0
    ? { ...market, status: STATUS_VOID }
    : { ...market, status: STATUS_SETTLED_YES };
}

/** What settleEngine reports, and what side effects it is allowed to fire. */
function engineReport(after) {
  const paidYes = after.status === STATUS_SETTLED_YES;
  return {
    outcome: paidYes ? "YES" : "VOID",
    settlesDuelsAsYes: paidYes,   // settleDuelsForMarket(market, 1)
    recordsPayoutLatency: paidYes, // recordSettle()
  };
}

console.log("a true predicate with backers on YES:");
{
  const after = kernelSettle({ status: STATUS_OPEN, predicateTrue: true, yesTotal: 0.02e9, noTotal: 0.05e9 });
  const r = engineReport(after);
  t("chain writes SETTLED_YES", after.status === STATUS_SETTLED_YES);
  t("engine reports YES", r.outcome === "YES");
  t("Fade Duels settle to YES", r.settlesDuelsAsYes);
  t("payout latency is recorded", r.recordsPayoutLatency);
}

console.log("a true predicate with NOBODY on YES — the bug the keeper found:");
{
  const after = kernelSettle({ status: STATUS_OPEN, predicateTrue: true, yesTotal: 0, noTotal: 0.05e9 });
  const r = engineReport(after);
  t("chain refunds instead of paying (STATUS_VOID)", after.status === STATUS_VOID);
  t("engine reports VOID, never YES", r.outcome === "VOID");
  t("Fade Duels are NOT settled as a YES win", !r.settlesDuelsAsYes);
  t("no payout latency is recorded for a refund", !r.recordsPayoutLatency);
}

console.log("an entirely empty pool (the anonymous market that started this):");
{
  const after = kernelSettle({ status: STATUS_OPEN, predicateTrue: true, yesTotal: 0, noTotal: 0 });
  t("settles as VOID", after.status === STATUS_VOID);
  t("and reports VOID", engineReport(after).outcome === "VOID");
}

console.log("a false predicate:");
{
  let threw = false;
  try { kernelSettle({ status: STATUS_OPEN, predicateTrue: false, yesTotal: 0.02e9, noTotal: 0 }); } catch { threw = true; }
  t("the chain refuses to settle at all (PredicateNotMet)", threw);
}

console.log("idempotence — the keeper sweeps every 20 seconds:");
{
  const once = kernelSettle({ status: STATUS_OPEN, predicateTrue: true, yesTotal: 0.02e9, noTotal: 0.05e9 });
  let threw = false;
  try { kernelSettle(once); } catch { threw = true; }
  t("a second crank on a settled market is rejected, not double-paid", threw);
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
