/** The headline number, measured: how long from a real World Cup goal in the signed feed to the payout
 *  confirmed on-chain.
 *
 * The live dress rehearsal could not produce this — TxLINE's dev feed streamed odds but never scores for
 * the live match, so there was no live goal to settle. But the settlement mechanism does not care whether
 * a goal is three seconds or three hours old: it proves `stat > threshold` from the anchored, signed data
 * and pays. So we measure it against a goal the feed genuinely carries — USA 2-0 Bosnia (fixture
 * 18172379), "USA to score twice" (stat 1 > 1, true because USA scored 2).
 *
 * What this measures is the part GAFFER owns: signed data available → settle proven on-chain → confirmed.
 * A live match adds exactly one thing on top — the wait for TxODDS to anchor the root that carries the
 * goal (~5 min cadence, measured elsewhere). That is their infrastructure's floor, not our latency. This
 * is the honest denominator of "paid the second it happens".
 *
 *   node scripts/measure-settle-latency.mjs      (needs a dev server on :3000 and ~0.1 devnet SOL)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Program } = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram, Keypair, Transaction } = require("@solana/web3.js");
const idl = require("../src/lib/latch.idl.json");

const FIXTURE = 18172379;      // USA 2-0 Bosnia — a finished fixture whose historical feed is fully populated
const STAT_KEY = 1;            // home (USA) goals
const THRESHOLD = 1;           // USA scored 2, so 2 > 1 is true → YES must win
const BASE = "http://localhost:3000";

const env = readFileSync(".env.local", "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim();
const RPC = pick("NEXT_PUBLIC_SOLANA_RPC") || "https://api.devnet.solana.com";
const ADMIN = pick("GAFFER_ADMIN_KEY");
const adminHeaders = ADMIN ? { "x-gaffer-key": ADMIN } : {};

const PROGRAM_ID = new PublicKey(idl.address);
const conn = new Connection(RPC, "confirmed");
const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../.devnet-key.json", "utf8"))));
const fan = Keypair.generate();

const asWallet = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (t) => (t.sign(kp), t), signAllTransactions: async (ts) => ts.map((t) => (t.sign(kp), t)) });
const programFor = (kp) => new Program(idl, new AnchorProvider(conn, asWallet(kp), { commitment: "confirmed" }));
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const vaultOf = (m) => pda(Buffer.from("vault"), m.toBuffer());
const positionOf = (m, owner, side) => pda(Buffer.from("position"), m.toBuffer(), owner.toBuffer(), Buffer.from([side]));
const sol = (l) => (l / 1e9).toFixed(6);

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

// ── open a pool on the real goal ────────────────────────────────────────────────────────────────────
const expirySecs = Math.floor(Date.now() / 1000) + 900;
const created = await fetch(`${BASE}/api/create-market`, {
  method: "POST", headers: { "content-type": "application/json", ...adminHeaders },
  body: JSON.stringify({ fixtureId: FIXTURE, statKey: STAT_KEY, period: 4, threshold: THRESHOLD, comparison: 0, expirySecs, lockSecs: expirySecs }),
}).then((r) => r.json());
if (!created.market) { console.error("create-market failed:", created); process.exit(1); }
const market = new PublicKey(created.market);
console.log(`\nmarket ${market.toBase58()}  ·  USA to score twice (stat ${STAT_KEY} > ${THRESHOLD})  ·  fixture ${FIXTURE}`);

// ── two wallets, opposite sides ─────────────────────────────────────────────────────────────────────
const FAN_FUNDING = 0.05e9, FAN_STAKE = 0.03e9, HOUSE_STAKE = 0.02e9;
await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: fan.publicKey, lamports: FAN_FUNDING })), [house]).then((s) => conn.confirmTransaction(s, "confirmed"));
const fanProgram = programFor(fan), houseProgram = programFor(house);
await fanProgram.methods.joinPool(1, new BN(FAN_STAKE)).accounts({ user: fan.publicKey, market, vault: vaultOf(market), position: positionOf(market, fan.publicKey, 1), systemProgram: SystemProgram.programId }).rpc();
await houseProgram.methods.joinPool(2, new BN(HOUSE_STAKE)).accounts({ user: house.publicKey, market, vault: vaultOf(market), position: positionOf(market, house.publicKey, 2), systemProgram: SystemProgram.programId }).rpc();
console.log(`  staked: YES ${sol(FAN_STAKE)} (fan) · NO ${sol(HOUSE_STAKE)} (house)`);

// ── THE MEASUREMENT: signed data available → payout proven and confirmed on-chain ───────────────────
// /api/settle runs settleMarket: fetch the anchored, signed proof bundle from TxLINE, build the settle
// transaction, submit it, and await confirmation. The clock spans exactly that.
const t0 = Date.now();
const settle = await fetch(`${BASE}/api/settle`, {
  method: "POST", headers: { "content-type": "application/json", ...adminHeaders },
  body: JSON.stringify({ market: market.toBase58() }),
}).then((r) => r.json());
const settleLatencyMs = Date.now() - t0;

t("the pool settled", settle?.settled === true, JSON.stringify(settle));
t("it proved the real goal (value 2 > 1)", settle?.provenValue === 2, `provenValue=${settle?.provenValue}`);
t("it paid YES, not void", settle?.outcome === "YES", `outcome=${settle?.outcome}`);
console.log(`  settle sig: ${settle?.sig}`);

// ── verify that settlement on-chain, not from the response ──────────────────────────────────────────
const tx = await conn.getTransaction(settle.sig, { maxSupportedTransactionVersion: 0 });
t("the settle tx is on-chain and succeeded", !!tx && tx.meta?.err === null);
const touches = tx && (tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys).some((k) => k.toBase58() === market.toBase58());
t("the tx touches this market account", !!touches);
const after = await houseProgram.account.market.fetch(market);
t("on-chain status is SETTLED_YES", after.status === 1, `status=${after.status}`);

// ── the winner is actually paid ─────────────────────────────────────────────────────────────────────
const config = pda(Buffer.from("config"));
const feeRecipient = (await houseProgram.account.config.fetch(config)).feeRecipient;
const before = await conn.getBalance(fan.publicKey);
await fanProgram.methods.claim().accounts({ owner: fan.publicKey, market, vault: vaultOf(market), position: positionOf(market, fan.publicKey, 1), config, feeRecipient, systemProgram: SystemProgram.programId }).rpc();
const gained = (await conn.getBalance(fan.publicKey)) - before;
t("the fan collected more than they staked", gained > FAN_STAKE, `${gained}`);

console.log(`\n  ┌─────────────────────────────────────────────────────────────`);
console.log(`  │ signed goal data → payout confirmed on-chain:  ${settleLatencyMs} ms`);
console.log(`  │ fan staked ${sol(FAN_STAKE)} → collected ${sol(gained)} SOL`);
console.log(`  │ (a live match adds only TxODDS's root-anchor wait, ~5 min cadence — their floor, not ours)`);
console.log(`  └─────────────────────────────────────────────────────────────`);

// return the winnings so the wallet is reusable
const dust = await conn.getBalance(fan.publicKey);
if (dust > 5000) await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: fan.publicKey, toPubkey: house.publicKey, lamports: dust - 5000 })), [fan]).catch(() => {});

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
