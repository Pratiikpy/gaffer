/** Payout arithmetic: the two sums that must never be confused.
 *
 * `projection(m, side, stake)` = "if I ADD this stake, what do I win" — the stake joins the pot and the side.
 * `heldPayout(m, side, amount)` = "I am ALREADY in for this much; what do I collect" — the stake is
 * already inside both totals, so adding it again understates the payout. Mirrors src/components/GafferApp.tsx.
 * Run: `node scripts/test-payout.mjs`
 */
let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const mk = (yesSol, noSol) => ({ yesTotal: String(Math.round(yesSol * 1e9)), noTotal: String(Math.round(noSol * 1e9)) });

function projection(m, side, stakeSol) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9;
  const sideNow = side === 1 ? yes : no;
  const potAfter = yes + no + stakeSol;
  const sideAfter = sideNow + stakeSol;
  const payout = sideAfter > 0 ? (potAfter * stakeSol) / sideAfter : stakeSol;
  return { payout, multiple: stakeSol > 0 ? payout / stakeSol : 0 };
}
function heldPayout(m, side, amountSol) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9;
  const pot = yes + no, sideTotal = side === 1 ? yes : no;
  return sideTotal > 0 ? (pot * amountSol) / sideTotal : amountSol;
}
/** What the chain actually pays a winning position (kernel `claim`): pot × your share of the winning side. */
const chainPayout = (yesSol, noSol, mineSol) => ((yesSol + noSol) * mineSol) / yesSol;

console.log("held positions — the bug that shipped in the live strip:");
{
  // The exact multi-user state we drove in the browser: A alone on YES 0.02, B on NO 0.05.
  const m = mk(0.02, 0.05);
  t("a lone YES backer collects the whole pot", near(heldPayout(m, 1, 0.02), 0.07));
  t("the chain agrees", near(heldPayout(m, 1, 0.02), chainPayout(0.02, 0.05, 0.02)));
  t("projection() would have UNDERSTATED it (why the two must not be swapped)",
    projection(m, 1, 0.02).payout < heldPayout(m, 1, 0.02) - 0.02,
    `projection=${projection(m, 1, 0.02).payout}`);
}
{
  const m = mk(0.06, 0.04);      // two YES backers, you hold half the side
  t("half the winning side collects half the pot", near(heldPayout(m, 1, 0.03), 0.05));
  t("and it matches the chain", near(heldPayout(m, 1, 0.03), chainPayout(0.06, 0.04, 0.03)));
  t("the NO side's holder is priced off the NO total", near(heldPayout(m, 2, 0.04), 0.10));
}
{
  const m = mk(0.05, 0);         // nobody faded you: you get your stake back, never less
  t("an unopposed position never pays less than the stake", near(heldPayout(m, 1, 0.05), 0.05));
}
{
  const m = mk(0, 0);            // empty pool, position not yet reflected
  t("an empty side falls back to the stake rather than dividing by zero", near(heldPayout(m, 1, 0.02), 0.02));
}

console.log("prospective stakes — projection() stays correct where it is used:");
{
  const m = mk(0.02, 0);
  const p = projection(m, 2, 0.05);   // B's real call sheet: 0.05 on the empty NO side
  t("B's sheet showed 0.07 to win", near(p.payout, 0.07));
  t("B's sheet showed 1.40×", near(p.multiple, 1.4));
}
{
  const m = mk(0, 0);
  t("first into an empty pool is offered their stake back at 1.00×", near(projection(m, 1, 0.05).payout, 0.05));
}
{
  // Backing the crowded side must pay less than backing the lonely one — the Scout reward, in arithmetic.
  const m = mk(0.09, 0.01);
  t("the minority side pays more than the majority side",
    projection(m, 2, 0.01).multiple > projection(m, 1, 0.01).multiple);
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
