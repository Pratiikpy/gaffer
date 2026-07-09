/** Squad-depth tests against the real database: Fade Duel invariants + settlement + the H2H ledger
 * (S6), and the moment-naming rule for the lore wall (Q2). Creates throwaway rows, then removes them.
 * Run: `node scripts/test-squad.mjs` */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL || readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();
const sql = neon(url);

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const CODE = "TEST" + String(Date.now()).slice(-6);
const A = "u_alice_" + Date.now(), B = "u_bob_" + Date.now();
const mk = (s) => `mkt_${s}_${Date.now()}`;

/** Mirror of squadPlus.createDuel's guards + canonical ordering. */
async function createDuel({ market, a, b, question = "q" }) {
  if (a.userId === b.userId) return null;
  if (a.side === b.side) return null;
  const [x, y] = a.userId < b.userId ? [a, b] : [b, a];
  const rows = await sql`
    INSERT INTO duels (squad_code, a_user, a_name, a_side, b_user, b_name, b_side, market, question, status, ts)
    VALUES (${CODE}, ${x.userId}, ${x.name}, ${x.side}, ${y.userId}, ${y.name}, ${y.side}, ${market}, ${question}, 'live', ${Date.now()})
    ON CONFLICT (squad_code, market, a_user, b_user) DO NOTHING RETURNING *`;
  return rows.length ? rows[0] : null;
}
/** Mirror of settleDuelsForMarket. */
async function settleDuels(market, winningSide) {
  const rows = await sql`SELECT * FROM duels WHERE market = ${market} AND status = 'live'`;
  for (const r of rows) {
    const winner = winningSide === 0 ? "void"
      : Number(r.a_side) === winningSide ? r.a_user
      : Number(r.b_side) === winningSide ? r.b_user : "void";
    await sql`UPDATE duels SET status='settled', winner=${winner} WHERE id=${r.id} AND status='live'`;
  }
  return rows.length;
}
async function h2h(x, y) {
  const rows = await sql`SELECT winner FROM duels WHERE squad_code=${CODE} AND status='settled'
    AND ((a_user=${x} AND b_user=${y}) OR (a_user=${y} AND b_user=${x}))`;
  let xw = 0, yw = 0, draws = 0;
  for (const r of rows) (r.winner === x ? xw++ : r.winner === y ? yw++ : draws++);
  return { x: xw, y: yw, draws };
}

console.log("S6 · Fade Duel invariants:");
{
  const m1 = mk("a");
  const d1 = await createDuel({ market: m1, a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 2 } });
  t("a duel is created between two opposed sides", !!d1);

  const dup = await createDuel({ market: m1, a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 2 } });
  t("the same pair cannot duel twice on one market", dup === null);

  // the MIRROR (B fades A) must hit the same unique row, not create a second duel
  const mirror = await createDuel({ market: m1, a: { userId: B, name: "Bob", side: 2 }, b: { userId: A, name: "Alice", side: 1 } });
  t("the mirror duel (B fades A) is the same duel, not a new one", mirror === null);

  const self = await createDuel({ market: mk("s"), a: { userId: A, name: "Alice", side: 1 }, b: { userId: A, name: "Alice", side: 2 } });
  t("you cannot fade yourself", self === null);

  const sameSide = await createDuel({ market: mk("x"), a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 1 } });
  t("a duel needs two different sides", sameSide === null);
}

console.log("S6 · settlement follows the pool, not a button:");
{
  const m = mk("settle");
  await createDuel({ market: m, a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 2 } });
  await settleDuels(m, 1);                                   // YES wins → Alice (side 1)
  const r = await sql`SELECT status, winner FROM duels WHERE market=${m}`;
  t("YES resolving hands the duel to the YES caller", r[0].status === "settled" && r[0].winner === A, `got ${r[0].winner}`);

  const again = await settleDuels(m, 2);                     // idempotent: nothing live left
  t("settling twice changes nothing", again === 0);

  const mv = mk("void");
  await createDuel({ market: mv, a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 2 } });
  await settleDuels(mv, 0);                                  // void
  const rv = await sql`SELECT winner FROM duels WHERE market=${mv}`;
  t("a voided pool settles the duel to nobody", rv[0].winner === "void");
}

console.log("S6 · the standing head-to-head:");
{
  for (const [i, side] of [[1, 1], [2, 1], [3, 2]]) {         // Alice wins 2, Bob wins 1
    const m = mk("h2h" + i);
    await createDuel({ market: m, a: { userId: A, name: "Alice", side: 1 }, b: { userId: B, name: "Bob", side: 2 } });
    await settleDuels(m, side);
  }
  const rec = await h2h(A, B);
  t("Alice leads Bob 3–1 (2 fresh + 1 from settlement above)", rec.x === 3 && rec.y === 1, JSON.stringify(rec));
  const mirrorRec = await h2h(B, A);
  t("the record reads the same from either side", mirrorRec.x === 1 && mirrorRec.y === 3, JSON.stringify(mirrorRec));
}

console.log("Q2 · moments are named from what happened:");
{
  const nameMoment = ({ kind, minute, roomRight, note }) => {
    const min = minute != null && minute > 0 ? `${minute}th-Minute` : "";
    const what = kind === "blackout" ? "Blackout" : "Freeze";
    const late = minute != null && minute >= 85;
    const title = [min, what].filter(Boolean).join(" ") || (late ? "The Late Window" : `The ${what}`);
    const detail = roomRight === true ? "The room called it. Everyone knew."
      : roomRight === false ? "The room got it wrong. Nobody saw it coming."
      : note || "It went quiet, and then it didn't.";
    return { title: `The ${title}`, detail };
  };
  const a = nameMoment({ kind: "blackout", minute: 89, roomRight: false });
  t('a late blackout becomes "The 89th-Minute Blackout"', a.title === "The 89th-Minute Blackout", a.title);
  t("a room that got it wrong is said so", a.detail.includes("wrong"));
  const b = nameMoment({ kind: "freeze", minute: 12, roomRight: true });
  t('an early freeze becomes "The 12th-Minute Freeze"', b.title === "The 12th-Minute Freeze", b.title);
  const c = nameMoment({ kind: "freeze", minute: null, roomRight: null, note: "" });
  t("an unknown minute never invents one", !/\d/.test(c.title), c.title);
}

await sql`DELETE FROM duels WHERE squad_code = ${CODE}`;
console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
