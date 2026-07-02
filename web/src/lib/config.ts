import { PublicKey } from "@solana/web3.js";

// Client-safe constants ONLY. This module is imported by client components (e.g. kernelClient),
// so it must never contain secrets. Server-only values (keypair path, admin key) live in
// `lib/serverConfig.ts`, which is guarded by `import "server-only"`.
export const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || process.env.SOLANA_RPC || "https://api.devnet.solana.com";
export const TXLINE_API = process.env.TXLINE_API || "https://txline-dev.txodds.com";
export const LATCH_PROGRAM = new PublicKey("HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG");
export const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
export const SUB_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
export const DEFAULT_FIXTURE = 17588388;
