"use client";
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction, useFundWallet } from "@privy-io/react-auth/solana";
import { KeypairWallet, type AppWallet } from "./wallet";
import { devKeypair } from "./walletStore";
import { fundWallet as faucet } from "./api";

export type WalletCtx = {
  wallet: AppWallet | null;   // null in Privy mode until the user logs in
  address: string;
  ready: boolean;
  mode: "privy" | "dev";
  authenticated: boolean;
  login: () => void;
  logout: () => void;
  /** Devnet faucet top-up of the wallet address (works for dev keypair + Privy embedded wallet). */
  fund: () => Promise<any>;
  /** Fiat on-ramp (Privy) — the production funding path; no-op in dev mode. */
  onramp: () => Promise<void>;
};

const Ctx = createContext<WalletCtx | null>(null);
export const useAppWallet = (): WalletCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAppWallet must be used within <Providers>");
  return c;
};

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/** Dev bridge: a local embedded keypair (no Privy). The devnet faucet funds it. */
function DevBridge({ children }: { children: React.ReactNode }) {
  const [kp] = useState<Keypair>(() => devKeypair());
  const wallet = useMemo<AppWallet>(() => new KeypairWallet(kp), [kp]);
  const address = kp.publicKey.toBase58();
  const fund = useCallback(() => faucet(address), [address]);
  const value = useMemo<WalletCtx>(() => ({ wallet, address, ready: true, mode: "dev", authenticated: true, login: () => {}, logout: () => {}, fund, onramp: async () => {} }), [wallet, address, fund]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Privy bridge: the embedded Solana wallet is the Anchor signer; Privy handles login + fiat on-ramp. */
function PrivyBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { fundWallet } = useFundWallet();
  const w = (wallets || []).find((x: any) => x.walletClientType === "privy") ?? (wallets && wallets[0]) ?? null; // the embedded wallet, not any external connector
  const address = w?.address ?? "";

  const wallet = useMemo<AppWallet | null>(() => {
    if (!w) return null;
    const pk = new PublicKey(w.address);
    async function sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      const bytes = tx instanceof VersionedTransaction ? tx.serialize() : (tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false });
      const res = await signTransaction({ transaction: bytes, wallet: w!, chain: "solana:devnet" });
      const signed = tx instanceof VersionedTransaction ? VersionedTransaction.deserialize(res.signedTransaction) : Transaction.from(Buffer.from(res.signedTransaction));
      return signed as T;
    }
    async function signAll<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> { return Promise.all(txs.map((t) => sign(t))); }
    return { publicKey: pk, signTransaction: sign, signAllTransactions: signAll };
  }, [w, signTransaction]);

  const fund = useCallback(() => (address ? faucet(address) : Promise.resolve()), [address]);
  const onramp = useCallback(async () => { if (address) await fundWallet({ address }); }, [address, fundWallet]);
  const value = useMemo<WalletCtx>(() => ({ wallet, address, ready: ready && walletsReady, mode: "privy", authenticated, login, logout, fund, onramp }), [wallet, address, ready, walletsReady, authenticated, login, logout, fund, onramp]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Chosen at render time: Privy when an app id is configured (must be inside PrivyProvider), else dev. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  return APP_ID ? <PrivyBridge>{children}</PrivyBridge> : <DevBridge>{children}</DevBridge>;
}
