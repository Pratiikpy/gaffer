/** K2 end-to-end: a STAKED Frozen Window, settled on-chain from two anchored proofs.
 *
 * Creates a market whose threshold is a DELTA (goals scored across the window), attaches a window that
 * opens before a real goal, stakes both sides, then cranks /api/settle-window. The kernel proves the move
 * across two snapshots and pays YES. Nothing here asserts the outcome; the chain does. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Program } = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram, Keypair } = require("@solana/web3.js");
const idl = require("../src/lib/latch.idl.json");

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const env = readFileSync(".env.local", "utf8");
const RPC = (env.match(/^NEXT_PUBLIC_SOLANA_RPC=(.+)$/m) || [])[1] || "https://api.devnet.solana.com";
const A = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../.devnet-key.json", "utf8"))));
const B = Keypair.generate();
const PROGRAM_ID = new PublicKey(idl.address);
const conn = new Connection(RPC, "confirmed");
const mk = (kp) => new Program(idl, new AnchorProvider(conn, { publicKey: kp.publicKey, signTransaction: async (t) => (t.sign(kp), t), signAllTransactions: async (ts) => ts.map((t) => (t.sign(kp), t)) }, { commitment: "confirmed" }));
const pa = mk(A), pb = mk(B);
const pda = (s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];

const FIXTURE = Number(process.argv[2] || 18193785);
const DELTA = 1;                 // "does anyone score across this window?"
const SIDE = { YES: 1, NO: 2 };

// The window opens before the match's first goal. The stream is a replay, so anchor the window to the
// match's own clock: start at the fixture's earliest event time.
const scores = await fetch(`${BASE}/api/scores/${FIXTURE}`).then((r) => r.json());
const anyTs = scores?.recent?.[0]?.Ts;
if (!anyTs) { console.error("no events for that fixture"); process.exit(1); }
const startTs = Math.floor(Number(anyTs) / 1000) - 6 * 3600;   // well before the first proof snapshot
const expiry = Math.floor(Date.now() / 1000) + 3600;

// fund B
const { Transaction } = require("@solana/web3.js");
await conn.confirmTransaction(await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.06e9 })), [A]), "confirmed");

// 1. create the market: threshold IS the delta
const id = new BN(Date.now()).mul(new BN(1000)).add(new BN(11));
const market = pda([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)]);
const vault = pda([Buffer.from("vault"), market.toBuffer()]);
await pa.methods.createMarket(id, new BN(FIXTURE), 1, 4, DELTA, 0, new BN(expiry), new BN(expiry))
  .accounts({ authority: A.publicKey, market, vault, systemProgram: SystemProgram.programId }).rpc();
console.log("market", market.toBase58().slice(0, 8), "· delta", DELTA);

// 2. attach the window (only before anyone stakes)
const windowPk = pda([Buffer.from("window"), market.toBuffer()]);
await pa.methods.openWindow(new BN(startTs))
  .accounts({ authority: A.publicKey, market, window: windowPk, systemProgram: SystemProgram.programId }).rpc();
const w = await pa.account.marketWindow.fetch(windowPk);
console.log("window opened · startTs", Number(w.startTs), "· delta", Number(w.delta));

// 3. a window that already has stakes cannot be re-pointed
try {
  await pa.methods.openWindow(new BN(startTs + 5)).accounts({ authority: A.publicKey, market, window: windowPk, systemProgram: SystemProgram.programId }).rpc();
  console.log("!! a second window was allowed — BUG");
} catch { console.log("second window refused (already exists)"); }

// 4. both sides stake
const pos = (kp, side) => pda([Buffer.from("position"), market.toBuffer(), kp.publicKey.toBuffer(), Buffer.from([side])]);
await pa.methods.joinPool(SIDE.YES, new BN(0.03e9)).accounts({ user: A.publicKey, market, vault, position: pos(A, SIDE.YES), systemProgram: SystemProgram.programId }).rpc();
await pb.methods.joinPool(SIDE.NO, new BN(0.05e9)).accounts({ user: B.publicKey, market, vault, position: pos(B, SIDE.NO), systemProgram: SystemProgram.programId }).rpc();
console.log("staked A YES 0.03 + B NO 0.05 · pot", ((await conn.getBalance(vault)) / 1e9).toFixed(4));

// 5. crank the window: the kernel proves the move across two anchored snapshots
const r = await fetch(`${BASE}/api/settle-window`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: market.toBase58() }) }).then((x) => x.json());
console.log("settle-window →", JSON.stringify(r));
if (!r.settled) process.exit(1);

const m = await pa.account.market.fetch(market);
console.log("market.status:", m.status, "(1 = SettledYes)");
if (m.status !== 1) process.exit(1);

// 6. the YES staker collects the whole pot — real money, from a window
const cfg = await pa.account.config.fetch(pda([Buffer.from("config")]));
const before = await conn.getBalance(A.publicKey);
await pa.methods.claim().accounts({ owner: A.publicKey, market, vault, position: pos(A, SIDE.YES), config: pda([Buffer.from("config")]), feeRecipient: cfg.feeRecipient, systemProgram: SystemProgram.programId }).rpc();
const won = ((await conn.getBalance(A.publicKey)) - before) / 1e9;
console.log(`A collected +${won.toFixed(4)} SOL from a STAKED window (proved ${r.from} → ${r.to}, delta ${r.delta})`);
console.log(won > 0.07 ? "✓✓ K2 PASS — the Frozen Window now takes real stakes and settles on-chain." : "✗ payout too small");
process.exit(won > 0.07 ? 0 : 1);
