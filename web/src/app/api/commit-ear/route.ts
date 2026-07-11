import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { loadServerKeypair, adminOk } from "@/lib/serverConfig";
import { RPC } from "@/lib/config";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Anchor a Gaffer's Ear event call on-chain, the instant it's made, so its timestamp cannot be back-dated.
 *
 * The Ear infers a match event (goal / stoppage / full-time) from the live market alone. To make "we called
 * it first" checkable, each call is written to Solana via the Memo program: a compact, human-readable line
 * plus a hash of the full evidence. The transaction's block time is the proof of *when* we knew — and the
 * score feed only confirms the event post-match, hours later.
 *
 * A memo costs ~5000 lamports, so this is guarded against being a drain vector: rate-limited per fixture and
 * globally, and it refuses to spend below a SOL floor. No wallet secret leaves the server; the deployed
 * agent just POSTs here. */

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MIN_SOL = 0.3;                    // never spend the server wallet below this
const PER_FIXTURE_MS = 6_000;           // dedupe rapid repeats of the same unfolding event
const GLOBAL_WINDOW_MS = 60_000, GLOBAL_MAX = 15;

const lastByFixture = new Map<number, number>();
let windowStart = 0, windowCount = 0;

function rateOk(fixtureId: number): string | null {
  const now = Date.now();
  const last = lastByFixture.get(fixtureId) || 0;
  if (now - last < PER_FIXTURE_MS) return "too soon for this fixture";
  if (now - windowStart > GLOBAL_WINDOW_MS) { windowStart = now; windowCount = 0; }
  if (windowCount >= GLOBAL_MAX) return "global rate limit";
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // Only the agent may write a call — an anonymous POST must not appear in the app as a genuine Ear call
    // (nor spend the shared wallet). Open only on a local dev server (ALLOW_OPEN_ADMIN), never in prod.
    if (!adminOk(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

    const b = await req.json().catch(() => ({}));
    const fixtureId = Number(b?.fixtureId) || 0;
    const kind = String(b?.kind || "");
    if (!fixtureId || !["goal", "stoppage", "fulltime"].includes(kind)) {
      return NextResponse.json({ ok: false, reason: "bad call" }, { status: 400 });
    }
    // Reserve the rate-limit slot BEFORE the (slow) transaction, so two concurrent calls can't both pass
    // the check while the first is still confirming.
    const rl = rateOk(fixtureId);
    if (rl) return NextResponse.json({ ok: false, reason: rl }, { status: 429 });
    lastByFixture.set(fixtureId, Date.now());
    windowCount += 1;

    const side = ["home", "away", "draw"].includes(String(b?.side)) ? String(b.side) : "";
    const conf = Math.max(0, Math.min(1, Number(b?.confidence) || 0));
    const evidence = String(b?.evidence || "").slice(0, 200);
    const ts = new Date().toISOString();

    // The on-chain record: readable on its own, and a hash that binds the full evidence + timestamp.
    const digest = createHash("sha256").update(`${fixtureId}|${kind}|${side}|${conf}|${evidence}|${ts}`).digest("hex").slice(0, 16);
    const memo = `GAFFER-EAR|${fixtureId}|${kind}|${side || "-"}|${Math.round(conf * 100)}|${digest}`;

    const conn = new Connection(RPC, "confirmed");
    const kp = loadServerKeypair();
    const bal = (await conn.getBalance(kp.publicKey)) / 1e9;
    if (bal < MIN_SOL) return NextResponse.json({ ok: false, reason: "below server SOL floor — anchoring paused" }, { status: 503 });

    const ix = new TransactionInstruction({ keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf8") });
    const tx = new Transaction().add(ix);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");

    // Persist the call so the live app feed can show it, with its on-chain proof. Server ts, not the
    // agent's — the timestamp is authoritative here. Best-effort: a DB hiccup never fails a landed commit.
    const team = String(b?.team || "").slice(0, 40);
    await db()`INSERT INTO ear_calls (fixture_id, kind, side, team, confidence, evidence, sig, hash, ts)
      VALUES (${fixtureId}, ${kind}, ${side || null}, ${team || null}, ${conf}, ${evidence}, ${sig}, ${digest}, ${Date.now()})`.catch(() => {});

    return NextResponse.json({ ok: true, sig, hash: digest, memo, ts });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: (e?.message || "commit failed").slice(0, 120) }, { status: 500 });
  }
}
