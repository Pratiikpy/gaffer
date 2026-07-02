import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path";
import latchIdl from "../idl/latch.json";
(async () => {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const prog: any = new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const all = await prog.account.parlay.all();
  all.sort((a: any, b: any) => Number(b.account.parlayId) - Number(a.account.parlayId));
  console.log("total parlays on-chain:", all.length);
  for (const p of all.slice(0, 3)) {
    const a = p.account;
    console.log(`  ${p.publicKey.toBase58().slice(0,8)} legs=${a.legs.length} yes=${Number(a.yesTotal)/1e9} no=${Number(a.noTotal)/1e9} status=${a.status} legsHit=${a.legsHit}`);
  }
})().catch(e => console.error(e?.message || e));
