import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC } from "@/lib/config";
import { loadServerKeypair, adminOk } from "@/lib/serverConfig";
import { addRollover, rolloverPot, markSwept } from "@/lib/economy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);

/** GET is the public number — everything carried in so far — UNLESS it is the daily cron (Vercel issues a
 * GET carrying the CRON_SECRET bearer), in which case it runs the sweep. Without this, nothing triggered
 * the sweep in production and the rollover pot the UI shows never filled. POST still sweeps for operators. */
export async function GET(req: NextRequest) {
  if (adminOk(req)) return sweep(req);   // authenticated GET === the daily cron → do the sweep
  return NextResponse.json(await rolloverPot());
}

/** T4 — sweep real remainders into the rollover pot.
 *
 * A settled pool's vault is only "dust" once EVERY position on it has been claimed: what's left is the
 * parimutuel rounding remainder, owed to nobody. A vault with an unclaimed winner still holds that
 * person's money, so it is skipped — we never roll a fan's payout into tomorrow's prize. The rent-exempt
 * minimum stays behind too (it's the account's, not the pot's). Idempotent per market via `swept`.
 */
export async function POST(req: NextRequest) { return sweep(req); }

async function sweep(req: NextRequest) {
  try {
    if (!adminOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));

    const marketDisc = Buffer.from((idl as any).accounts.find((a: any) => a.name === "Market").discriminator);
    const raws = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(marketDisc) } }] });

    // Every Position, grouped by its market. `side` matters: a LOSING position is never claimed (there
    // is nothing to claim), so it must not block the sweep forever — only money actually owed does.
    const positions = await program.account.position.all();
    const byMarket = new Map<string, { claimed: boolean; side: number }[]>();
    for (const p of positions as any[]) {
      const m = p.account.market.toBase58();
      if (!byMarket.has(m)) byMarket.set(m, []);
      byMarket.get(m)!.push({ claimed: !!p.account.claimed, side: Number(p.account.side) });
    }
    const SIDE_YES = 1;
    /** Is anyone still owed money out of this vault?
     *  status 1 (SettledYes): only unclaimed YES holders are owed.
     *  status 2 (Void):       every unclaimed holder, either side, is owed their stake back. */
    const stillOwed = (status: number, pos: { claimed: boolean; side: number }[]) =>
      status === 1 ? pos.some((p) => !p.claimed && p.side === SIDE_YES) : pos.some((p) => !p.claimed);

    let sweptLamports = 0, sweptMarkets = 0;
    const skipped: string[] = [];

    for (const r of raws) {
      if (r.account.data.length !== 112) continue;                       // prior-layout account
      let acc: any;
      try { acc = program.coder.accounts.decode("market", r.account.data); } catch { continue; }
      if (acc.status === 0) continue;                                    // still open — not settled
      const mk = r.pubkey.toBase58();
      const pos = byMarket.get(mk) ?? [];
      if (stillOwed(acc.status, pos)) { skipped.push(mk.slice(0, 6)); continue; } // a fan's payout is still in there

      const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), r.pubkey.toBuffer()], PROGRAM_ID)[0];
      const bal = await conn.getBalance(vault);
      const rent = await conn.getMinimumBalanceForRentExemption(0);      // vault is a bare system PDA
      const dust = bal - rent;
      if (dust <= 0) continue;
      // Claim this market's dust exactly once — a second sweep must not inflate the pot.
      if (!(await markSwept(mk, dust))) continue;
      sweptLamports += dust; sweptMarkets++;
    }

    if (sweptLamports > 0) await addRollover(sweptLamports, sweptMarkets);
    return NextResponse.json({ sweptLamports, sweptMarkets, skipped, pot: await rolloverPot() });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 140) }, { status: 500 });
  }
}
