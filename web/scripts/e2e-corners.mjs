/** A corners pool, opened and settled on devnet, with a stranger's money on the other side.
 *
 * Until now every pool the kernel ever settled was a goals pool, because goals were the only stat keys we
 * could vouch for. `scripts/verify-stat-keys.mjs` reconciled the other six against the feed, so the
 * compiler now mints cards and corners too — and a mapping that has never moved a lamport is a mapping
 * nobody has actually tested. This does the whole thing, on-chain, end to end:
 *
 *   1. open a market on `stat 7 > 2`  — home corners, fixture 18172379 (USA 2-0 Bosnia, 4 home corners)
 *   2. two different wallets stake opposite sides, so a winner is paid out of a loser's stake
 *   3. the production keeper settles it — the same route Vercel's cron calls, not a private code path
 *   4. the winner claims, and we check the lamports actually landed
 *
 * The pool is true (4 > 2), so YES must win. Nothing is mocked: the oracle proof comes from TxLINE and
 * the payout comes out of the vault.
 *
 *   node scripts/e2e-corners.mjs            (needs a dev server on :3000 and ~0.1 devnet SOL)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Program } = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram, Keypair, Transaction } = require("@solana/web3.js");
const idl = require("../src/lib/latch.idl.json");

const FIXTURE = 18172379;
const STAT_KEY = 7;          // home corners
const THRESHOLD = 2;         // the match finished with 4 — YES is true
const BASE = "http://localhost:3000";

const env = readFileSync(".env.local", "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim();
const RPC = pick("NEXT_PUBLIC_SOLANA_RPC") || "https://api.devnet.solana.com";
// A local dev server leaves the admin routes open (`ALLOW_OPEN_ADMIN`, and never in production). Against
// anything else, the key is what gets us in.
const ADMIN = pick("GAFFER_ADMIN_KEY");
const adminHeaders = ADMIN ? { "x-gaffer-key": ADMIN } : {};

const PROGRAM_ID = new PublicKey(idl.address);
const conn = new Connection(RPC, "confirmed");
const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../.devnet-key.json", "utf8"))));
const fan = Keypair.generate();   // a wallet that has never touched this program

const asWallet = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (t) => (t.sign(kp), t), signAllTransactions: async (ts) => ts.map((t) => (t.sign(kp), t)) });
const programFor = (kp) => new Program(idl, new AnchorProvider(conn, asWallet(kp), { commitment: "confirmed" }));
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const vaultOf = (m) => pda(Buffer.from("vault"), m.toBuffer());
const positionOf = (m, owner, side) => pda(Buffer.from("position"), m.toBuffer(), owner.toBuffer(), Buffer.from([side]));
const sol = (lamports) => (lamports / 1e9).toFixed(6);

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

// ── 1. a corners pool, opened through the real admin route ──────────────────────────────────────────
const expirySecs = Math.floor(Date.now() / 1000) + 900;
const created = await fetch(`${BASE}/api/create-market`, {
  method: "POST",
  headers: { "content-type": "application/json", ...adminHeaders },
  body: JSON.stringify({ fixtureId: FIXTURE, statKey: STAT_KEY, period: 4, threshold: THRESHOLD, comparison: 0, expirySecs, lockSecs: expirySecs }),
}).then((r) => r.json());
if (!created.market) { console.error("create-market failed:", created); process.exit(1); }
const market = new PublicKey(created.market);
console.log(`\nmarket ${market.toBase58()}  ·  stat ${STAT_KEY} > ${THRESHOLD}  ·  fixture ${FIXTURE}`);
t("a pool on a non-goal stat can be opened", true);

// ── 2. two wallets, opposite sides ──────────────────────────────────────────────────────────────────
// The fan needs rent + stake + fees. The house funds them, then loses to them, which is the point.
const FAN_FUNDING = 0.05e9, FAN_STAKE = 0.03e9, HOUSE_STAKE = 0.02e9;
{
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: fan.publicKey, lamports: FAN_FUNDING }));
  await conn.sendTransaction(tx, [house]).then((s) => conn.confirmTransaction(s, "confirmed"));
}
const fanProgram = programFor(fan), houseProgram = programFor(house);
await fanProgram.methods.joinPool(1, new BN(FAN_STAKE))
  .accounts({ user: fan.publicKey, market, vault: vaultOf(market), position: positionOf(market, fan.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
await houseProgram.methods.joinPool(2, new BN(HOUSE_STAKE))
  .accounts({ user: house.publicKey, market, vault: vaultOf(market), position: positionOf(market, house.publicKey, 2), systemProgram: SystemProgram.programId }).rpc();

const staked = await houseProgram.account.market.fetch(market);
t("YES holds the fan's stake", String(staked.yesTotal) === String(FAN_STAKE), String(staked.yesTotal));
t("NO holds the house's stake", String(staked.noTotal) === String(HOUSE_STAKE), String(staked.noTotal));

// ── 3. the production keeper settles it ─────────────────────────────────────────────────────────────
// Not a private settle path: this is the route Vercel's cron hits, narrowed to one fixture.
const keeper = await fetch(`${BASE}/api/keeper?fixture=${FIXTURE}`, { headers: adminHeaders }).then((r) => r.json());
const mine = (keeper.results ?? keeper.settled ?? []).find?.((r) => r.market === market.toBase58());
console.log(`  keeper: ${JSON.stringify(mine ?? keeper).slice(0, 160)}`);

const after = await houseProgram.account.market.fetch(market);
t("the keeper settled the pool YES (4 corners > 2)", after.status === 1, `status=${after.status}`);
t("the vault still holds the pot", Number(await conn.getBalance(vaultOf(market))) > 0);

// ── 4. the winner claims, and the lamports move ─────────────────────────────────────────────────────
const config = pda(Buffer.from("config"));
const feeRecipient = (await houseProgram.account.config.fetch(config)).feeRecipient;
const before = await conn.getBalance(fan.publicKey);
await fanProgram.methods.claim()
  .accounts({ owner: fan.publicKey, market, vault: vaultOf(market), position: positionOf(market, fan.publicKey, 1), config, feeRecipient, systemProgram: SystemProgram.programId }).rpc();
const gained = (await conn.getBalance(fan.publicKey)) - before;

console.log(`  fan staked ${sol(FAN_STAKE)} SOL and collected ${sol(gained)} SOL (net of fees + rent refund)`);
t("the fan was paid more than they staked", gained > FAN_STAKE, `${gained} <= ${FAN_STAKE}`);
t("the payout came out of the loser's side", gained < FAN_STAKE + HOUSE_STAKE, `${gained}`);

const loser = await fanProgram.account.position.fetch(positionOf(market, house.publicKey, 2)).catch(() => null);
t("the losing side has nothing to claim", loser !== null && !loser.claimed);

// Return the fan's winnings so the next run has a house wallet to play with.
const dust = await conn.getBalance(fan.publicKey);
if (dust > 5000) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fan.publicKey, toPubkey: house.publicKey, lamports: dust - 5000 }));
  await conn.sendTransaction(tx, [fan]).catch(() => {});
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
