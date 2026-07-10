import { NextRequest, NextResponse } from "next/server";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "@/lib/latch.idl.json";
import { KeypairWallet } from "@/lib/wallet";
import { RPC } from "@/lib/config";
import { loadServerKeypair } from "@/lib/serverConfig";
import { listMarkets } from "@/lib/kernel";
import { txline } from "@/lib/txline";
import { expiryForFixture } from "@/lib/matchWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROGRAM_ID = new PublicKey((idl as any).address);
// The hero demo fixture: finished + anchored USA v Bosnia (USA won 2-0) — a pool here settles on the
// real proof the moment a judge collects, so the PAID moment is always reachable, live match or not.
const HERO_FIXTURE = 18172379;
const SEED_NO = 0.06;  // seeded counter-side liquidity: the winner takes a visible profit
const SEED_YES = 0.02;

/** The server keypair must never be minted down to nothing.
 *
 * Every pool this route stands up costs the wallet its rent plus `SEED_YES + SEED_NO` of real liquidity,
 * and the route is ungated by design — a fan opening a match they like should not find it empty. But that
 * same wallet is the keeper's settler, the faucet, and the on-chain TxLINE subscriber whose signature
 * mints our API token. Simply browsing between fixtures spent 0.17 SOL of it in one sitting.
 *
 * So minting has a floor. Below it, an empty match stays empty and everything that actually matters —
 * settling pools that already hold people's money — keeps working. */
const MIN_SERVER_SOL = 1.5;

// Parimutuel settle is global — the first fan to collect closes a pool. So this route keeps pools ALIVE:
// for the hero fixture, one open "USA to score"; for any real scheduled fixture (a live match a fan just
// opened), the standard pair "home to score" / "away to score". Idempotent + throttled on the mint path.
const hits = new Map<string, number[]>();
function throttled(key: string, max: number): boolean {
  const now = Date.now(), w = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (w.length >= max) { hits.set(key, w); return true; }
  w.push(now); hits.set(key, w); return false;
}

/** Can the wallet afford to stand up a pool without eating into what settlement needs? */
async function canMint(conn: Connection, kp: any): Promise<boolean> {
  const bal = (await conn.getBalance(kp.publicKey)) / 1e9;
  return bal - (SEED_YES + SEED_NO) >= MIN_SERVER_SOL;
}

async function mintPool(program: any, kp: any, fixtureId: number, statKey: number): Promise<string> {
  // A pool must expire when the match does, or its NO side can never be proven (see matchWindow.ts).
  const expiry = await expiryForFixture(fixtureId);
  const id = new BN(Date.now()).mul(new BN(1000)).add(new BN(Math.floor(Math.random() * 1000)));
  const market = PublicKey.findProgramAddressSync([Buffer.from("market"), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
  const pos = (s: number) => PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), kp.publicKey.toBuffer(), Buffer.from([s])], PROGRAM_ID)[0];
  await program.methods.createMarket(id, new BN(fixtureId), statKey, 4, 0, 0, new BN(expiry), new BN(expiry))
    .accounts({ authority: kp.publicKey, market, vault, systemProgram: SystemProgram.programId }).rpc();
  await program.methods.joinPool(2, new BN(Math.round(SEED_NO * 1e9))).accounts({ user: kp.publicKey, market, vault, position: pos(2), systemProgram: SystemProgram.programId }).rpc();
  await program.methods.joinPool(1, new BN(Math.round(SEED_YES * 1e9))).accounts({ user: kp.publicKey, market, vault, position: pos(1), systemProgram: SystemProgram.programId }).rpc();
  return market.toBase58();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const askedFixture = Number(body?.fixtureId) || 0;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const program: any = new Program(idl as any, new AnchorProvider(conn, new KeypairWallet(kp), { commitment: "confirmed" }));
    const markets = await listMarkets();
    const openOn = (fix: number) => markets.filter((m) => m.fixtureId === String(fix) && m.status === 0 && m.threshold >= 0 && m.threshold <= 40);

    // A real scheduled fixture was asked for (a fan opened a match with no pools) → stand up the pair.
    if (askedFixture && askedFixture !== HERO_FIXTURE) {
      const schedule = await txline().fixturesSnapshot();
      const known = schedule.some((f: any) => Number(f.FixtureId) === askedFixture);
      if (!known) return NextResponse.json({ error: "unknown fixture" }, { status: 400 });
      const open = openOn(askedFixture);
      if (open.length > 0) return NextResponse.json({ markets: open.map((m) => m.pubkey), created: false });
      if (throttled("mint", 6) || throttled(ip, 3)) return NextResponse.json({ error: "warming up — try again in a moment" }, { status: 429 });
      if (!(await canMint(conn, kp))) return NextResponse.json({ markets: [], created: false, reason: "no pools on that match yet" });
      const created = [await mintPool(program, kp, askedFixture, 1), await mintPool(program, kp, askedFixture, 2)]; // home / away to score
      return NextResponse.json({ markets: created, created: true });
    }

    // Default: keep the hero "USA to score" alive.
    const hero = openOn(HERO_FIXTURE).find((m) => m.statKey === 1 && m.threshold === 0);
    if (hero) return NextResponse.json({ market: hero.pubkey, created: false });
    if (throttled("mint", 6) || throttled(ip, 3)) return NextResponse.json({ error: "warming up — try again in a moment" }, { status: 429 });
    if (!(await canMint(conn, kp))) return NextResponse.json({ market: null, created: false, reason: "no pools open right now" });
    const market = await mintPool(program, kp, HERO_FIXTURE, 1);
    return NextResponse.json({ market, created: true });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
