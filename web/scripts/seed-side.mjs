/** Dev/QA helper: stake one side of a market with the server keypair, so a pool has a real
 * counterparty to win from. Usage: node scripts/seed-side.mjs <market> <side 1=YES|2=NO> <sol> */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Program } = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram, Keypair } = require("@solana/web3.js");
const idl = require("../src/lib/latch.idl.json");

const env = readFileSync(".env.local", "utf8");
const RPC = (env.match(/^NEXT_PUBLIC_SOLANA_RPC=(.+)$/m) || [])[1] || "https://api.devnet.solana.com";
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../.devnet-key.json", "utf8"))));
const PROGRAM_ID = new PublicKey(idl.address);
const market = new PublicKey(process.argv[2]);
const side = Number(process.argv[3] ?? 2);
const sol = Number(process.argv[4] ?? 0.05);

const conn = new Connection(RPC, "confirmed");
const wallet = { publicKey: kp.publicKey, signTransaction: async (t) => (t.sign(kp), t), signAllTransactions: async (ts) => ts.map((t) => (t.sign(kp), t)) };
const program = new Program(idl, new AnchorProvider(conn, wallet, { commitment: "confirmed" }));
const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
const position = PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), kp.publicKey.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];

const sig = await program.methods.joinPool(side, new BN(Math.round(sol * 1e9)))
  .accounts({ user: kp.publicKey, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
const m = await program.account.market.fetch(market);
console.log(`seeded side ${side} with ${sol} · ${sig}`);
console.log("yesTotal:", String(m.yesTotal), "noTotal:", String(m.noTotal));
