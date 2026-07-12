import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { RPC } from "@/lib/config";
import { listMarkets } from "@/lib/kernel";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public live-usage stats — the whole parimutuel footprint, recomputed from chain (not a stored counter).
 *
 * Positions are parsed raw so no account-layout drift can break the count: 83 bytes =
 * disc(8) market(32) owner(32) side(1) amount(8) claimed(1) bump(1) — owner@40, claimed@81. Markets +
 * settlement come from the same on-chain read the app uses. Anyone can reproduce these numbers with
 * `node scripts_judge-verify-usage.mjs` — nothing here is a self-reported metric. */
export async function GET() {
  try {
    const stats = await cached("usage-stats", { ttlMs: 60_000, swrMs: 300_000, staleMs: 3_600_000 }, async () => {
      const conn = new Connection(RPC, "confirmed");
      const PROGRAM = new PublicKey((idl as any).address);
      const accts = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 83 }] });
      const wallets = new Set<string>();
      let joins = 0, claims = 0;
      for (const a of accts) {
        const d = a.account.data; if (d.length !== 83) continue;
        joins++;
        wallets.add(new PublicKey(d.subarray(40, 72)).toBase58());
        if (d[81] === 1) claims++;
      }
      const markets = await listMarkets();
      const settled = markets.filter((m) => m.status === 1 || m.status === 3).length;
      return { wallets: wallets.size, pools: markets.length, joins, settled, claims, updatedAt: Date.now(), verify: "node scripts_judge-verify-usage.mjs" };
    });
    return NextResponse.json(stats);
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
