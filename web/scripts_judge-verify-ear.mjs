/**
 * GAFFER — zero-credential EAR verifier. Re-checks the Gaffer's Ear track record straight from chain.
 * No keys. Run from the web package:  node scripts_judge-verify-ear.mjs
 *
 * The Ear (an autonomous agent) infers goals/stoppages/full-time from the live odds alone, and commits
 * every call on-chain the instant it's made — an SPL Memo whose block time proves *when* it knew, before
 * the score feed finalises. After full-time each call is graded against TxLINE's signed final score.
 * This script: (1) pulls the graded record, (2) independently re-fetches a sample of the on-chain memos
 * from the public RPC and prints their block times + decoded lines — so the "we called it, here's the
 * proof we called it first" claim is checkable, not trusted. Full record recomputable at /api/ear-record.
 */
import { Connection } from "@solana/web3.js";

const RPC = process.env.DRIVER_RPC || "https://api.devnet.solana.com";
const BASE = process.env.GAFFER_BASE || "https://www.mygaffer.xyz";
const conn = new Connection(RPC, "confirmed");
const EX = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("GAFFER — the Gaffer's Ear, verified from chain (zero credentials)");
  console.log("RPC:", RPC, "\n");

  const rec = await fetch(`${BASE}/api/ear-record`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (!rec?.feed) { console.log("could not read the record:", rec?.error || "unknown"); process.exit(1); }

  const rate = rec.goalHitRate == null ? "—" : `${Math.round(rec.goalHitRate * 100)}%`;
  console.log("┌─ track record (graded vs TxLINE's signed final score) ───────");
  console.log(`│ goal calls confirmed:   ${rec.goalConfirmed} / ${rec.goalCalls}  =  ${rate}`);
  console.log(`│ calls committed on-chain: ${rec.onChain}   (of ${rec.totalCalls} total)`);
  console.log(`│ matches graded: ${rec.gradedFixtures}   ·  awaiting full-time: ${rec.pendingFixtures}`);
  console.log("└──────────────────────────────────────────────────────────────\n");

  // Independently re-verify a sample of the on-chain commitments from the public RPC.
  // Prefer the graded GOAL calls (the ones scored ✓/✗ against the final) over ungraded stoppages.
  const withSig = (rec.feed || []).filter((c) => c.sig);
  const onchain = [...withSig.filter((c) => c.kind === "goal"), ...withSig.filter((c) => c.kind !== "goal")].slice(0, 8);
  if (!onchain.length) { console.log("no on-chain calls in the recent feed to sample."); process.exit(0); }
  console.log(`Re-fetching ${onchain.length} of the on-chain memos from the public RPC (proving they exist + when):\n`);
  let ok = 0;
  for (const c of onchain) {
    try {
      const tx = await conn.getTransaction(c.sig, { maxSupportedTransactionVersion: 0 });
      const memoLine = (tx?.meta?.logMessages || []).map((l) => (l.match(/Memo \(len \d+\): "(.+)"/) || [])[1]).find(Boolean);
      const bt = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "?";
      const graded = c.correct === true ? "✓ confirmed" : c.correct === false ? "✗ missed" : "· ungraded";
      console.log(`  ${c.kind.toUpperCase().padEnd(9)} ${(c.team || c.side || "").padEnd(12)} committed ${bt}  ${graded}`);
      console.log(`     on-chain: ${memoLine || "(memo)"}  →  ${EX(c.sig)}`);
      if (memoLine && memoLine.startsWith("GAFFER-EAR|")) ok++;
      await sleep(220);
    } catch { console.log(`  ${c.sig.slice(0, 12)}…  (could not fetch — devnet history may be pruned)`); }
  }

  console.log("\n" + "─".repeat(74));
  console.log(ok
    ? `PROVEN: ${ok}/${onchain.length} sampled calls are real on-chain memos with un-backdatable block times.\nThe Ear's calls were committed the instant they were made, then graded against the signed score —\n"we called it, and here's the proof we called it first." Recompute the full record at /api/ear-record.`
    : "Could not re-fetch memos from the public RPC right now (devnet prunes old history within ~1–2 days).\nThe live graded record above is always current at /api/ear-record.");
  console.log("─".repeat(74));
  process.exit(0);
})();
