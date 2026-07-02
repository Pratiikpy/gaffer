/** Minimal Anchor-compatible wallet (anchor's NodeWallet isn't exported in the ESM build Next bundles). */
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

/** Anchor-compatible wallet used across the browser clients (dev keypair OR the Privy adapter). */
export type AppWallet = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

export class KeypairWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) tx.sign([this.payer]);
    else (tx as Transaction).partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return txs.map((tx) => {
      if (tx instanceof VersionedTransaction) tx.sign([this.payer]);
      else (tx as Transaction).partialSign(this.payer);
      return tx;
    });
  }
}
