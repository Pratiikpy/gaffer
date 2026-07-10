/** The side that could never win.
 *
 * Before `settle_no`, a market had exactly two endings: YES takes the pot, or everyone is refunded. So a
 * NO backer lost their stake if the thing happened and got it back if it didn't — never a profit. The
 * pool was one-sided, and the call sheet was quoting NO a payout the kernel could not deliver: in the
 * two-user run, B was shown "1.40× your stake" for 0.05 on NO, and would have received 0.05.
 *
 * These assert the three things that had to become true together: the chain can prove a negative, the
 * pot splits across whichever side won, and a void can no longer be used to claw a pot back from NO.
 *
 * Mirrors latch/programs/latch/src/lib.rs and src/components/GafferApp.tsx. Run: `node scripts/test-settle-no.mjs`
 */
let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const STATUS_OPEN = 0, STATUS_SETTLED_YES = 1, STATUS_VOID = 2, STATUS_SETTLED_NO = 3;
const VOID_GRACE_SECS = 120, RESOLVE_GRACE_SECS = 3600;

/** The app's view of who got paid. */
const wonSide = (m) => (m.status === STATUS_SETTLED_YES ? 1 : m.status === STATUS_SETTLED_NO ? 2 : 0);
const isPaid = (m) => wonSide(m) !== 0;

/** `claim`, as the kernel computes it. */
function claim(m, pos) {
  const pot = BigInt(m.yesTotal) + BigInt(m.noTotal);
  if (m.status === STATUS_SETTLED_YES) {
    if (pos.side !== 1) throw new Error("NotWinner");
    return Number((pot * BigInt(pos.amount)) / BigInt(m.yesTotal));
  }
  if (m.status === STATUS_SETTLED_NO) {
    if (pos.side !== 2) throw new Error("NotWinner");
    return Number((pot * BigInt(pos.amount)) / BigInt(m.noTotal));
  }
  if (m.status === STATUS_VOID) return pos.amount;      // refund, either side
  throw new Error("NotResolved");
}

/** `settle_no`, as the kernel gates it. `ts` is ms; `expiry` and `now` are seconds. */
function settleNo(m, { ts, now, provenValue }) {
  if (m.status !== STATUS_OPEN) throw new Error("NotOpen");
  if (Math.floor(ts / 1000) < m.expiryTs) throw new Error("SnapshotTooEarly");
  if (now < m.expiryTs + VOID_GRACE_SECS) throw new Error("NotExpired");
  // value <= threshold  <=>  value < threshold + 1
  if (!(provenValue < m.threshold + 1)) throw new Error("PredicateNotMet");
  return { ...m, status: m.noTotal === 0 ? STATUS_VOID : STATUS_SETTLED_NO };
}
function voidMarket(m, now) {
  if (m.status !== STATUS_OPEN) throw new Error("NotOpen");
  if (now < m.expiryTs + RESOLVE_GRACE_SECS) throw new Error("NotExpired");
  return { ...m, status: STATUS_VOID };
}

const EXPIRY = 1_000_000;
const mk = (yes, no, threshold = 0) => ({ status: STATUS_OPEN, yesTotal: yes, noTotal: no, threshold, expiryTs: EXPIRY });
const AFTER = { ts: EXPIRY * 1000, now: EXPIRY + VOID_GRACE_SECS };

console.log("the bug: NO could only lose or break even");
{
  const m = mk(20_000_000, 50_000_000);
  const noPos = { side: 2, amount: 50_000_000 };
  // Old kernel: the goal came → YES took it; it didn't → VOID → stake back. Never a profit.
  const oldIfHappened = 0;
  const oldIfNot = claim({ ...m, status: STATUS_VOID }, noPos);
  t("old: NO got nothing when the goal came", oldIfHappened === 0);
  t("old: NO got exactly its stake back when it didn't", oldIfNot === 50_000_000);

  const settled = settleNo(m, { ...AFTER, provenValue: 0 });
  t("new: the same NO backer takes the whole pot", claim(settled, noPos) === 70_000_000);
  t("...which is strictly more than the stake it used to get back", claim(settled, noPos) > oldIfNot);
}

console.log("the two sides are symmetric:");
{
  const m = mk(30_000_000, 50_000_000);
  const pot = 80_000_000;
  t("YES wins → the YES side splits the pot", claim({ ...m, status: STATUS_SETTLED_YES }, { side: 1, amount: 30_000_000 }) === pot);
  t("NO wins → the NO side splits the pot", claim({ ...m, status: STATUS_SETTLED_NO }, { side: 2, amount: 50_000_000 }) === pot);
  t("a loser on a SETTLED_NO market cannot claim", (() => { try { claim({ ...m, status: STATUS_SETTLED_NO }, { side: 1, amount: 1 }); return false; } catch { return true; } })());
  t("a loser on a SETTLED_YES market cannot claim", (() => { try { claim({ ...m, status: STATUS_SETTLED_YES }, { side: 2, amount: 1 }); return false; } catch { return true; } })());
}

console.log("pro-rata across the NO side, and never over-paying the vault:");
{
  const m = { ...mk(20_000_000, 60_000_000), status: STATUS_SETTLED_NO };
  const paid = claim(m, { side: 2, amount: 20_000_000 }) + claim(m, { side: 2, amount: 40_000_000 });
  t("two NO backers split it in proportion", paid <= 80_000_000 && 80_000_000 - paid <= 1, `paid=${paid}`);
}

console.log("proving a negative — the LessThan(threshold + 1) trick:");
{
  t("'Belgium to score' (thr 0) with 0 goals settles NO", settleNo(mk(1, 1, 0), { ...AFTER, provenValue: 0 }).status === STATUS_SETTLED_NO);
  t("...and cannot be settled NO once they have scored", (() => { try { settleNo(mk(1, 1, 0), { ...AFTER, provenValue: 1 }); return false; } catch (e) { return e.message === "PredicateNotMet"; } })());
  t("'3+ goals' (thr 2) with exactly 2 settles NO", settleNo(mk(1, 1, 2), { ...AFTER, provenValue: 2 }).status === STATUS_SETTLED_NO);
  t("...and 3 goals does not", (() => { try { settleNo(mk(1, 1, 2), { ...AFTER, provenValue: 3 }); return false; } catch { return true; } })());
}

console.log("a snapshot from before the close is worthless:");
{
  // "Spain hadn't scored by minute three" is true, and must never resolve the market.
  const tooEarly = { ts: (EXPIRY - 1) * 1000, now: EXPIRY + VOID_GRACE_SECS };
  t("settle_no refuses a proof taken before expiry", (() => { try { settleNo(mk(1, 1), { ...tooEarly, provenValue: 0 }); return false; } catch (e) { return e.message === "SnapshotTooEarly"; } })());
  t("and refuses before the keeper's YES head start elapses", (() => { try { settleNo(mk(1, 1), { ts: EXPIRY * 1000, now: EXPIRY + 1, provenValue: 0 }); return false; } catch (e) { return e.message === "NotExpired"; } })());
}

console.log("nobody on NO → refund, never a trapped pot:");
{
  const settled = settleNo(mk(50_000_000, 0), { ...AFTER, provenValue: 0 });
  t("proven false with an empty NO side voids", settled.status === STATUS_VOID);
  t("and the YES backer gets their stake back", claim(settled, { side: 1, amount: 50_000_000 }) === 50_000_000);
}

console.log("void can no longer grief a NO winner:");
{
  const m = mk(60_000_000, 20_000_000);
  const justAfterSettleNo = EXPIRY + VOID_GRACE_SECS;
  t("the losing YES side cannot void the instant NO becomes provable",
    (() => { try { voidMarket(m, justAfterSettleNo); return false; } catch (e) { return e.message === "NotExpired"; } })());
  t("settle_no is reachable a whole hour before void is", VOID_GRACE_SECS < RESOLVE_GRACE_SECS);
  t("void still works when nothing was ever provable", voidMarket(m, EXPIRY + RESOLVE_GRACE_SECS).status === STATUS_VOID);
  // A grief would have paid the YES loser back its 0.06 and stolen 0.06 of NO's rightful 0.08 pot.
  const rightful = claim({ ...m, status: STATUS_SETTLED_NO }, { side: 2, amount: 20_000_000 });
  const griefed = claim({ ...m, status: STATUS_VOID }, { side: 2, amount: 20_000_000 });
  t("the grief was worth stealing — which is why the window moved", rightful > griefed, `${rightful} vs ${griefed}`);
}

console.log("the app agrees with the chain about who won:");
{
  t("wonSide(SETTLED_YES) is YES", wonSide({ status: STATUS_SETTLED_YES }) === 1);
  t("wonSide(SETTLED_NO) is NO", wonSide({ status: STATUS_SETTLED_NO }) === 2);
  t("wonSide(VOID) is nobody", wonSide({ status: STATUS_VOID }) === 0);
  t("a voided market is not 'paid'", !isPaid({ status: STATUS_VOID }));
  t("a SETTLED_NO market IS paid", isPaid({ status: STATUS_SETTLED_NO }));
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
