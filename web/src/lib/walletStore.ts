"use client";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/** Dev embedded wallet: a keypair persisted in localStorage. Stands in for the Privy
 * embedded wallet so the full stake/claim loop runs without an external Privy app id. */
const K = "gaffer_dev_sk";

export function devKeypair(): Keypair {
  if (typeof window === "undefined") return Keypair.generate();
  const s = localStorage.getItem(K);
  if (s) {
    try { return Keypair.fromSecretKey(bs58.decode(s)); } catch { /* fall through */ }
  }
  const kp = Keypair.generate();
  localStorage.setItem(K, bs58.encode(kp.secretKey));
  return kp;
}
