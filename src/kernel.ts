/** LATCH kernel client — PDAs + the create/join/settle/claim instructions. */
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import latchIdl from "../idl/latch.json";
import { TXORACLE } from "./txline";

export const COMPARISON = { GreaterThan: 0, LessThan: 1, EqualTo: 2 } as const;
export const SIDE = { YES: 1, NO: 2 } as const;
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });

export class Kernel {
  program: any;
  constructor(public conn: Connection, public wallet: Keypair) {
    this.program = new Program(latchIdl as any, new AnchorProvider(conn, new Wallet(wallet), { commitment: "confirmed" }));
  }
  private progFor(user: Keypair): any {
    return user.publicKey.equals(this.wallet.publicKey)
      ? this.program
      : new Program(latchIdl as any, new AnchorProvider(this.conn, new Wallet(user), { commitment: "confirmed" }));
  }

  marketPda(id: BN) { return PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], this.program.programId)[0]; }
  vaultPda(market: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], this.program.programId)[0]; }
  positionPda(market: PublicKey, user: PublicKey, side: number) { return PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), user.toBuffer(), Buffer.from([side])], this.program.programId)[0]; }
  dsrPda(seedTs: number) { const day = Math.floor(seedTs / 86400000); return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(day).toArrayLike(Buffer, "le", 2)], TXORACLE)[0]; }

  async createMarket(id: BN, fixtureId: number, statKey: number, period: number, threshold: number, comparison: number, expiryTs: number, lockTs?: number) {
    const market = this.marketPda(id), vault = this.vaultPda(market);
    const lock = lockTs ?? expiryTs; // KILL-1 cut-off for new stakes; defaults to expiry when not a timed flash pool
    const sig = await this.program.methods.createMarket(id, new BN(fixtureId), statKey, period, threshold, comparison, new BN(lock), new BN(expiryTs))
      .accounts({ authority: this.wallet.publicKey, market, vault, systemProgram: SystemProgram.programId }).rpc();
    return { market, vault, sig };
  }

  async joinPool(market: PublicKey, user: Keypair, side: number, lamports: number) {
    const vault = this.vaultPda(market), position = this.positionPda(market, user.publicKey, side);
    return await this.progFor(user).methods.joinPool(side, new BN(lamports))
      .accounts({ user: user.publicKey, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
  }

  /** Settle a market by submitting a TxLINE proof bundle (CPI into validate_stat). */
  async settle(market: PublicKey, bundle: any) {
    const seedTs = Number(bundle.summary.updateStats.minTimestamp);
    const fixtureSummary = {
      fixtureId: new BN(bundle.summary.fixtureId),
      updateStats: { updateCount: bundle.summary.updateStats.updateCount, minTimestamp: new BN(bundle.summary.updateStats.minTimestamp), maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp) },
      eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
    };
    const statA = { statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period }, eventStatRoot: bundle.eventStatRoot, statProof: bundle.statProof.map(node) };
    return await this.program.methods.settle(new BN(seedTs), fixtureSummary, bundle.subTreeProof.map(node), bundle.mainTreeProof.map(node), statA, null, null)
      .accounts({ settler: this.wallet.publicKey, market, dailyScoresMerkleRoots: this.dsrPda(seedTs), txoracleProgram: TXORACLE })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
  }

  async claim(market: PublicKey, user: Keypair, side: number) {
    return await this.progFor(user).methods.claim()
      .accounts({ owner: user.publicKey, market, vault: this.vaultPda(market), position: this.positionPda(market, user.publicKey, side), systemProgram: SystemProgram.programId }).rpc();
  }

  fetchMarket(market: PublicKey) { return this.program.account.market.fetch(market); }

  /** Open markets, decoded resiliently. Anchor's `.all()` is all-or-nothing — one account written
   * before a struct field (e.g. lock_ts) was added throws and blanks the whole list, which would kill
   * the keeper mid-run. We fetch by discriminator, keep only current-layout accounts (8 + INIT_SPACE =
   * 112 bytes), and decode each on its own. */
  async listOpenMarkets() {
    const disc = Buffer.from((latchIdl as any).accounts.find((a: any) => a.name === "Market").discriminator);
    const raws = await this.conn.getProgramAccounts(this.program.programId, {
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    const out: { publicKey: PublicKey; account: any }[] = [];
    for (const r of raws) {
      if (r.account.data.length !== 112) continue; // prior-layout account — skip before decode
      try {
        const acc = this.program.coder.accounts.decode("market", r.account.data);
        if (acc.status === 0) out.push({ publicKey: r.pubkey, account: acc });
      } catch { /* undecodable — skip */ }
    }
    return out;
  }
}
