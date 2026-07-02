"use client";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "./latch.idl.json";
import type { AppWallet } from "./wallet";
import { RPC } from "./config";

const PROGRAM_ID = new PublicKey((idl as any).address);

/** Browser-side kernel writes (stake/claim) signed by the app wallet (dev keypair or Privy embedded). */
export class BrowserKernel {
  conn: Connection;
  program: any;
  constructor(public wallet: AppWallet) {
    this.conn = new Connection(RPC, "confirmed");
    this.program = new Program(idl as any, new AnchorProvider(this.conn, this.wallet as any, { commitment: "confirmed" }));
  }
  private vault(m: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], PROGRAM_ID)[0]; }
  private position(m: PublicKey, side: number) { return PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), this.wallet.publicKey.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0]; }

  async balanceSol(): Promise<number> { return (await this.conn.getBalance(this.wallet.publicKey)) / 1e9; }

  async join(marketStr: string, side: number, sol: number): Promise<string> {
    const m = new PublicKey(marketStr);
    return await this.program.methods.joinPool(side, new BN(Math.round(sol * 1e9)))
      .accounts({ user: this.wallet.publicKey, market: m, vault: this.vault(m), position: this.position(m, side), systemProgram: SystemProgram.programId }).rpc();
  }
  async claim(marketStr: string, side: number): Promise<string> {
    const m = new PublicKey(marketStr);
    return await this.program.methods.claim()
      .accounts({ owner: this.wallet.publicKey, market: m, vault: this.vault(m), position: this.position(m, side), systemProgram: SystemProgram.programId }).rpc();
  }
  async myPosition(marketStr: string, side: number): Promise<{ amount: number; claimed: boolean } | null> {
    try {
      const p: any = await this.program.account.position.fetch(this.position(new PublicKey(marketStr), side));
      return { amount: Number(p.amount) / 1e9, claimed: p.claimed };
    } catch { return null; }
  }

  /** Every Position this wallet owns, in ONE getProgramAccounts call (owner is at byte offset 40:
   * 8 disc + 32 market). Used to show only the markets a user can actually claim/refund. */
  async myPositions(): Promise<{ market: string; side: number; amount: number; claimed: boolean }[]> {
    try {
      const rows = await this.program.account.position.all([{ memcmp: { offset: 40, bytes: this.wallet.publicKey.toBase58() } }]);
      return rows.map((r: any) => ({ market: r.account.market.toBase58(), side: r.account.side, amount: Number(r.account.amount) / 1e9, claimed: r.account.claimed }));
    } catch { return []; }
  }
}
