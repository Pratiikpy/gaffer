"use client";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "./latch.idl.json";
import type { AppWallet } from "./wallet";
import { RPC } from "./config";

const PROGRAM_ID = new PublicKey((idl as any).address);

/** Browser-side parlay writes (create/join/claim) signed by the app wallet — the user pays their
 * own rent to open a slip, so it is permissionless and never spends the shared keeper keypair. */
export class BrowserParlay {
  conn: Connection;
  program: any;
  constructor(public wallet: AppWallet) {
    this.conn = new Connection(RPC, "confirmed");
    this.program = new Program(idl as any, new AnchorProvider(this.conn, this.wallet as any, { commitment: "confirmed" }));
  }
  private vault(p: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("pvault"), p.toBuffer()], PROGRAM_ID)[0]; }
  private position(p: PublicKey, side: number) { return PublicKey.findProgramAddressSync([Buffer.from("pposition"), p.toBuffer(), this.wallet.publicKey.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0]; }
  private parlayPda(id: BN) { return PublicKey.findProgramAddressSync([Buffer.from("parlay"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0]; }

  /** Create a parlay signed + rent-funded by the USER's own wallet (not the server keypair) —
   * so opening a slip is permissionless and can never drain the shared keeper wallet. */
  async create(fixtureId: number, legs: { statKey: number; period: number; threshold: number; comparison: number }[], expirySecs: number, lockSecs?: number): Promise<string> {
    const id = new BN(Date.now()).mul(new BN(1000)).add(new BN(Math.floor(Math.random() * 1000))); // ms + entropy → no same-ms PDA collision
    const parlay = this.parlayPda(id);
    const vault = this.vault(parlay);
    const lock = lockSecs ?? expirySecs; // KILL-1 cut-off for new calls; defaults to expiry when a slip has no earlier lock
    await this.program.methods.createParlay(id, new BN(fixtureId), legs, new BN(lock), new BN(expirySecs))
      .accounts({ authority: this.wallet.publicKey, parlay, vault, systemProgram: SystemProgram.programId }).rpc();
    return parlay.toBase58();
  }

  async join(parlayStr: string, side: number, sol: number): Promise<string> {
    const p = new PublicKey(parlayStr);
    return await this.program.methods.joinParlay(side, new BN(Math.round(sol * 1e9)))
      .accounts({ user: this.wallet.publicKey, parlay: p, vault: this.vault(p), position: this.position(p, side), systemProgram: SystemProgram.programId }).rpc();
  }
  async claim(parlayStr: string, side: number): Promise<string> {
    const p = new PublicKey(parlayStr);
    return await this.program.methods.claimParlay()
      .accounts({ owner: this.wallet.publicKey, parlay: p, vault: this.vault(p), position: this.position(p, side), systemProgram: SystemProgram.programId }).rpc();
  }
  async myPosition(parlayStr: string, side: number): Promise<{ amount: number; claimed: boolean } | null> {
    try { const pos: any = await this.program.account.position.fetch(this.position(new PublicKey(parlayStr), side)); return { amount: Number(pos.amount) / 1e9, claimed: pos.claimed }; }
    catch { return null; }
  }
}
