/** Read-only kernel access for the UI: list/fetch markets + PDA helpers.
 * (Write paths — join/claim — are signed in the browser by the Privy wallet, added with the screens.) */
import { AnchorProvider, BN, Program, utils } from "@coral-xyz/anchor";
import { KeypairWallet } from "./wallet";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "./latch.idl.json";
import { RPC } from "./config";

/** 0 open · 1 YES won · 2 refunded · 3 NO won. Index 3 exists because a market can now be settled
 *  against its predicate — "it never happened, and the people who said so take the pot". */
export const STATUS_LABEL = ["live", "paid", "refunded", "paid"];

export function readProgram(): any {
  const conn = new Connection(RPC, "confirmed");
  // read-only: a throwaway wallet that never signs
  const provider = new AnchorProvider(conn, new KeypairWallet(Keypair.generate()), { commitment: "confirmed" });
  return new Program(idl as any, provider);
}

/** Exact on-chain account size = 8 (discriminator) + <Struct>::INIT_SPACE. Anchor allocates the full
 * INIT_SPACE at init (Parlay reserves max_len(8) legs), so every live account of the current layout is
 * exactly this many bytes; a prior layout is shorter. The length guard is essential, not cosmetic: a
 * fixed-size struct like Market throws when an old shorter buffer is decoded, but a Vec-bearing struct
 * like Parlay can shift-decode an old buffer into GARBAGE without throwing. Update these if the structs
 * change. Verified against devnet: Market 104+8=112, Parlay 208+8=216 (old layouts 104-8 / 208-8). */
const ACCOUNT_LEN: Record<string, number> = { market: 112, parlay: 216 };

/** Resilient list: fetch program accounts by discriminator, keep only those whose byte length matches
 * the current layout, and decode each on its own. Anchor's `.all()` is all-or-nothing — a single stale
 * account (e.g. one written before `lock_ts` was added) would otherwise throw and blank the whole list. */
async function decodeAll(p: any, name: "market" | "parlay"): Promise<{ publicKey: PublicKey; account: any }[]> {
  const idlAcc = (idl as any).accounts.find((a: any) => a.name.toLowerCase() === name);
  const disc = Buffer.from(idlAcc.discriminator);
  const raws = await p.provider.connection.getProgramAccounts(p.programId, {
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } }],
  });
  const out: { publicKey: PublicKey; account: any }[] = [];
  for (const r of raws) {
    if (r.account.data.length !== ACCOUNT_LEN[name]) continue; // prior-layout account — skip before decode
    try { out.push({ publicKey: r.pubkey, account: p.coder.accounts.decode(name, r.account.data) }); }
    catch { /* unexpected undecodable account — skip */ }
  }
  return out;
}

/** The set of markets that carry a `MarketWindow` — a delta ("does the score move across this window?")
 * predicate rather than an absolute one. The generic `settle`/`settle_no` path proves the ABSOLUTE stat,
 * so it would mis-settle a windowed market; the keeper must route these through settle-window instead.
 * One `getProgramAccounts` per sweep, parsed by the `market` pubkey at offset 8 (no decode needed). */
export async function windowedMarketPubkeys(p: any): Promise<Set<string>> {
  const idlAcc = (idl as any).accounts.find((a: any) => a.name === "MarketWindow");
  if (!idlAcc) return new Set();
  const disc = Buffer.from(idlAcc.discriminator);
  const raws = await p.provider.connection.getProgramAccounts(p.programId, {
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } }],
  });
  const out = new Set<string>();
  for (const r of raws) if (r.account.data.length >= 40) out.add(new PublicKey(r.account.data.subarray(8, 40)).toBase58());
  return out;
}

export interface MarketView {
  pubkey: string;
  marketId: string;
  fixtureId: string;
  statKey: number;
  period: number;
  threshold: number;
  comparison: number;
  status: number;
  statusLabel: string;
  yesTotal: string;
  noTotal: string;
  potSol: number;
  lockTs: string;
  /** When the predicate can no longer come true. Past `expiry + VOID_GRACE_SECS` the keeper refunds. */
  expiryTs: string;
  /** Server-joined: can the NO side ever be proven? False on pools whose match is already over. */
  noResolvable?: boolean;
  settleTs: string;
}

export async function listMarkets(): Promise<MarketView[]> {
  const p = readProgram();
  const all = await decodeAll(p, "market");
  return all.map((m) => {
    const a = m.account;
    const pot = (Number(a.yesTotal) + Number(a.noTotal)) / 1e9;
    return {
      pubkey: m.publicKey.toBase58(),
      marketId: a.marketId.toString(),
      fixtureId: a.fixtureId.toString(),
      statKey: a.statKey,
      period: a.period,
      threshold: a.threshold,
      comparison: a.comparison,
      status: a.status,
      statusLabel: STATUS_LABEL[a.status] ?? String(a.status),
      yesTotal: a.yesTotal.toString(),
      noTotal: a.noTotal.toString(),
      potSol: pot,
      lockTs: a.lockTs.toString(),
      expiryTs: a.expiryTs.toString(),
      settleTs: a.settleTs.toString(),
    };
  }).sort((x: MarketView, y: MarketView) => Number(y.marketId) - Number(x.marketId));
}

export const marketPda = (program: any, id: BN) =>
  PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], program.programId)[0];

export interface ParlayLegView { statKey: number; period: number; threshold: number; comparison: number; hit: boolean }
export interface ParlayView {
  pubkey: string;
  parlayId: string;
  fixtureId: string;
  legs: ParlayLegView[];
  legsHit: number;
  status: number;
  statusLabel: string;
  yesTotal: string;
  noTotal: string;
  potSol: number;
  lockTs: string;
  expiryTs: string;
}

// status 3 = parlay busted → NO won; label it as a finished/decided pot in felt terms.
const PARLAY_STATUS = ["live", "won", "refunded", "decided"];

export async function listParlays(): Promise<ParlayView[]> {
  const p = readProgram();
  const all = await decodeAll(p, "parlay");
  return all.map((x) => {
    const a = x.account;
    return {
      pubkey: x.publicKey.toBase58(),
      parlayId: a.parlayId.toString(),
      fixtureId: a.fixtureId.toString(),
      legs: a.legs.map((l: any) => ({ statKey: l.statKey, period: l.period, threshold: l.threshold, comparison: l.comparison, hit: l.hit })),
      legsHit: a.legsHit,
      status: a.status,
      statusLabel: PARLAY_STATUS[a.status] ?? String(a.status),
      yesTotal: a.yesTotal.toString(),
      noTotal: a.noTotal.toString(),
      potSol: (Number(a.yesTotal) + Number(a.noTotal)) / 1e9,
      lockTs: a.lockTs.toString(),
      expiryTs: a.expiryTs.toString(),
    };
  }).sort((m: ParlayView, n: ParlayView) => Number(n.parlayId) - Number(m.parlayId));
}
