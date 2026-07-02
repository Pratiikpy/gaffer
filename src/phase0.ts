/**
 * GAFFER / LATCH — Phase-0 spike
 *
 * The single go/no-go that gates GAFFER's "PAID moment": can a market self-settle
 * trustlessly on TxLINE's devnet via `validate_stat`, and is scores data anchored
 * at fine enough granularity to settle in-play?
 *
 * Stages (each clearly gated by what it needs):
 *   1. Auth                         — no funds. Confirms the API host + guest JWT.
 *   2. On-chain anchoring probe      — no funds. Are daily_scores_roots / daily_batch_roots
 *                                      PDAs being written on devnet, and how recently?
 *   3. Full proof + validate_stat    — needs ~0.1 devnet SOL on the wallet:
 *        subscribe (free SL1) -> activate -> apiToken -> fetch a real /scores/stat-validation
 *        bundle -> derive daily_scores_roots PDA -> SIMULATE validate_stat ->
 *        measure compute units + confirm Ok (no revert) against the on-chain root.
 *
 * Run:  npm run phase0      (after `npm install`)
 * Fund: the printed wallet address with ~0.1 devnet SOL (https://faucet.solana.com)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import axios from "axios";
import * as nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";
import idl from "../idl/txoracle.json";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const API = process.env.TXLINE_API || "https://txline-dev.txodds.com";
const PROGRAM_ID = new PublicKey((idl as any).address);
const KEY_PATH = path.join(__dirname, "..", ".devnet-key.json");

const sec = (t: string) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));
const ok = (s: string) => console.log("  ✓ " + s);
const warn = (s: string) => console.log("  ⚠ " + s);
const pause = (s: string) => console.log("  ⏸ " + s);

function rootPda(seed: string, day: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), new BN(day).toArrayLike(Buffer, "le", 2)],
    PROGRAM_ID
  )[0];
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEY_PATH, "utf8"))));
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: any = new Program(idl as any, provider);

  sec("PHASE-0 SPIKE · GAFFER / LATCH · " + new Date().toISOString());
  console.log("  RPC      :", RPC);
  console.log("  API      :", API);
  console.log("  Program  :", PROGRAM_ID.toBase58(), "(devnet trading stack)");
  console.log("  Wallet   :", kp.publicKey.toBase58());
  const balLamports = await conn.getBalance(kp.publicKey);
  console.log("  Balance  :", (balLamports / 1e9).toFixed(4), "SOL");

  const summary: string[] = [];

  // ---------------- STAGE 1: AUTH ----------------
  sec("STAGE 1 · Auth (no funds needed)");
  const http = axios.create({ baseURL: API, timeout: 30000, headers: { "Content-Type": "application/json" } });
  let jwt = "";
  try {
    const r = await http.post("/auth/guest/start");
    jwt = r.data.token;
    http.defaults.headers.common["Authorization"] = `Bearer ${jwt}`;
    ok(`guest JWT obtained (${jwt.length} chars) from ${API}`);
    summary.push("✓ API reachable + guest auth OK (" + API + ")");
  } catch (e: any) {
    warn("auth failed: " + e.message);
    summary.push("✗ auth FAILED on " + API);
    printSummary(summary);
    return;
  }

  // ---------------- STAGE 2: ANCHORING PROBE ----------------
  sec("STAGE 2 · On-chain anchoring probe (no funds needed)");
  const nowDay = Math.floor(Date.now() / 86400000);
  let scoresDays = 0, oddsDays = 0;
  const scanDays = process.env.SKIP_PROBE ? 0 : 20;
  if (process.env.SKIP_PROBE) console.log("  (probe skipped via SKIP_PROBE — already confirmed: scores roots on 17/21 days)");
  else console.log("  epochDay(now) =", nowDay, "— scanning last 21 days for anchored roots\n");
  for (let d = nowDay; d >= nowDay - scanDays && !process.env.SKIP_PROBE; d--) {
    const sP = rootPda("daily_scores_roots", d);
    const bP = rootPda("daily_batch_roots", d);
    const [sInfo, bInfo] = await Promise.all([conn.getAccountInfo(sP), conn.getAccountInfo(bP)]);
    if (sInfo || bInfo) {
      console.log(
        `  day ${d}: scores_roots ${sInfo ? "EXISTS " + sInfo.data.length + "B" : "-"}` +
        ` | batch_roots ${bInfo ? "EXISTS " + bInfo.data.length + "B" : "-"}`
      );
      if (sInfo) scoresDays++;
      if (bInfo) oddsDays++;
    }
  }
  console.log(`\n  scores-root days = ${scoresDays} | odds-root days = ${oddsDays} (of last 21)`);
  if (scoresDays > 0) { ok("devnet IS anchoring scores roots"); summary.push(`✓ scores-root anchoring on devnet (${scoresDays} recent days)`); }
  else { warn("no scores roots at these PDAs in 21 days — re-runs may anchor under the event's own day; Stage 3 resolves the exact ts"); summary.push("⚠ no recent scores roots found by date scan (resolve via Stage 3)"); }

  // ---------------- STAGE 3: FULL PROOF + SIMULATE ----------------
  sec("STAGE 3 · Proof bundle + validate_stat simulation (needs ~0.1 devnet SOL)");
  if (balLamports < 0.02e9) {
    pause("SKIPPED — wallet has no devnet SOL (the free-tier subscribe still pays a tx fee).");
    console.log("\n  To run the full proof, fund this address with ~0.1 devnet SOL, then `npm run phase0`:");
    console.log("    " + kp.publicKey.toBase58());
    console.log("    Faucet: https://faucet.solana.com   (or: solana airdrop 1 " + kp.publicKey.toBase58() + " --url devnet)");
    summary.push("⏸ validate_stat simulation + CU measurement PENDING devnet SOL");
    printSummary(summary);
    return;
  }

  // 3a. subscribe to free World Cup tier (SL1) — costs only the tx fee, no TxL
  // Mint: the IDL constant (AfDq) is stale and the handler rejects it; the live devnet
  // subscription mint is 4Zao (addresses.mdx + freshly-seeded treasury balance). Overridable.
  const MINT = new PublicKey(process.env.SUB_MINT || "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], PROGRAM_ID);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], PROGRAM_ID);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    conn, kp, MINT, kp.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log("  subscribing (service level 1, 4 weeks, free)...");
  const SELECTED_LEAGUES: number[] = [];
  let subSig = "";
  try {
    subSig = await program.methods.subscribe(1, 4).accounts({
      user: kp.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: MINT,
      userTokenAccount: userTokenAccount.address,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    ok("subscribed: " + subSig);
  } catch (e: any) {
    if (process.env.SUB_SIG) { subSig = process.env.SUB_SIG; warn("re-subscribe failed (" + (e.error?.errorCode?.code || e.message) + ") — reusing SUB_SIG for activation"); }
    else throw e;
  }

  // 3b. activate -> apiToken
  const msg = new TextEncoder().encode(`${subSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("base64");
  const act = await axios.post(`${API}/api/token/activate`, { txSig: subSig, walletSignature, leagues: SELECTED_LEAGUES }, { headers: { Authorization: `Bearer ${jwt}` } });
  const apiToken = act.data.token || act.data;
  http.defaults.headers.common["X-Api-Token"] = apiToken;
  ok("apiToken activated");

  // 3c. find a fixture+seq with scores data (try World Cup soccer fixtures, then the known example fixture)
  const candidates = [17588388, 17588316, 17588306, 17588228, 17271370]; // WC soccer ids + the docs example
  let bundle: any = null, used: any = null;
  for (const fixtureId of candidates) {
    try {
      const hist = await http.get(`/api/scores/historical/${fixtureId}`, { transformResponse: (r) => r });
      const raw: string = typeof hist.data === "string" ? hist.data : JSON.stringify(hist.data);
      const events = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"))
        .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean) as any[];
      if (!events.length) { console.log(`  fixture ${fixtureId}: empty stream`); continue; }
      const seqEvents = events.filter((e) => (e.seq ?? e.Seq) != null);
      const states = [...new Set(events.map((e) => e.GameState ?? e.gameState ?? e.statusSoccerId).filter((x) => x != null))];
      console.log(`  fixture ${fixtureId}: ${events.length} events, ${seqEvents.length} with seq, states=[${states.slice(0, 8).join(",")}]`);
      if (!seqEvents.length) { console.log(`    sample event keys: ${Object.keys(events[events.length - 1]).slice(0, 14).join(",")}`); continue; }
      const seqs = [...new Set(seqEvents.map((e) => Number(e.seq ?? e.Seq)))].sort((a, b) => a - b);
      // try a spread of seqs (older ones are more likely already anchored in daily_scores_roots)
      const pick = [...new Set([
        seqs[Math.floor(seqs.length * 0.6)], seqs[Math.floor(seqs.length * 0.4)],
        seqs[Math.floor(seqs.length * 0.8)], seqs[Math.floor(seqs.length * 0.2)], seqs[seqs.length - 1],
      ])].filter((x) => x != null);
      for (const seq of pick) {
        try {
          const v = await http.get("/api/scores/stat-validation", { params: { fixtureId, seq, statKey: 1 } });
          if (v.data && v.data.ts) { bundle = v.data; used = { fixtureId, seq }; break; }
          console.log(`    seq ${seq}: no ts — ${JSON.stringify(v.data).slice(0, 120)}`);
        } catch (e: any) { console.log(`    seq ${seq}: ${e.response?.status || ""} ${(e.response?.data && JSON.stringify(e.response.data).slice(0, 100)) || e.message}`); }
      }
      if (bundle) break;
    } catch (e: any) {
      console.log(`  fixture ${fixtureId}: ${e.response?.status || ""} ${e.message}`);
    }
  }
  if (!bundle) {
    warn("could not obtain a stat-validation bundle from the candidate fixtures (devnet may not be replaying these right now).");
    summary.push("⚠ auth+subscribe+token OK, but no live proof bundle from candidate fixtures — need a fixtureId/seq that is currently replaying on devnet");
    printSummary(summary);
    return;
  }
  ok(`got proof bundle for fixture ${used.fixtureId} seq ${used.seq} (ts=${bundle.ts})`);

  // 3d. derive the daily_scores_roots PDA. The program (validate_stat.rs:25) checks that the
  // ts used for seed generation matches the timestamp inside the snapshot payload (the summary),
  // so use the batch's summary timestamp, not the top-level bundle.ts.
  const minTs = Number(bundle.summary.updateStats.minTimestamp);
  const maxTs = Number(bundle.summary.updateStats.maxTimestamp);
  const seedTs = process.env.SEED_TS === "max" ? maxTs : process.env.SEED_TS === "bundle" ? Number(bundle.ts) : minTs;
  console.log(`  ts candidates → bundle.ts=${bundle.ts}  min=${minTs}  max=${maxTs}  → using seedTs=${seedTs} (SEED_TS=min|max|bundle)`);
  const epochDay = Math.floor(seedTs / 86400000);
  const dsr = rootPda("daily_scores_roots", epochDay);
  const dsrInfo = await conn.getAccountInfo(dsr);
  console.log(`  bundle epochDay = ${epochDay} → daily_scores_roots ${dsr.toBase58()} : ${dsrInfo ? "EXISTS " + dsrInfo.data.length + "B" : "MISSING"}`);
  if (!dsrInfo) { warn("root account missing for this ts — cannot validate"); summary.push("⚠ proof bundle obtained but its daily_scores_roots PDA is not on-chain"); printSummary(summary); return; }

  // 3e. build validate_stat args and SIMULATE (monotone predicate guaranteed true -> measures happy-path CU)
  const statToProve = {
    statToProve: { key: bundle.statToProve.key, value: bundle.statToProve.value, period: bundle.statToProve.period },
    eventStatRoot: bundle.eventStatRoot,
    statProof: bundle.statProof.map((n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling })),
  };
  const fixtureSummary = {
    fixtureId: new BN(bundle.summary.fixtureId),
    updateStats: {
      updateCount: bundle.summary.updateStats.updateCount,
      minTimestamp: new BN(bundle.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(bundle.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: bundle.summary.eventStatsSubTreeRoot,
  };
  const fixtureProof = bundle.subTreeProof.map((n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));
  const mainTreeProof = bundle.mainTreeProof.map((n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling }));
  const predicate = { threshold: 1000, comparison: { lessThan: {} } }; // monotone counts are always < 1000 -> Ok

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const ix = await program.methods
    .validateStat(new BN(seedTs), fixtureSummary, fixtureProof, mainTreeProof, predicate, statToProve, null, null)
    .accounts({ dailyScoresMerkleRoots: dsr })
    .instruction();
  const tx = new Transaction().add(cuIx).add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  console.log("  simulating validate_stat (predicate: stat < 1000, must pass)...");
  const sim = await conn.simulateTransaction(tx, undefined, false);
  const cu = sim.value.unitsConsumed;
  const err = sim.value.err;
  (sim.value.logs || []).slice(-6).forEach((l) => console.log("    | " + l));
  if (err) {
    warn("simulation returned err: " + JSON.stringify(err) + " (proof rejected or predicate false)");
    summary.push("✗ validate_stat simulation reverted: " + JSON.stringify(err));
  } else {
    ok(`validate_stat PASSED in simulation — trustless settlement verified`);
    ok(`compute units consumed: ${cu} / 1,400,000 ceiling`);
    summary.push(`✓ validate_stat works on devnet soccer proof — ${cu} CU (ceiling 1.4M)`);
    summary.push(cu && cu < 1_400_000 ? "✓ fits a single tx — GO for the self-settling kernel" : "⚠ near/over the CU ceiling — split + Jito-bundle");
  }

  printSummary(summary);
}

function printSummary(s: string[]) {
  sec("PHASE-0 RESULT");
  s.forEach((l) => console.log("  " + l));
  console.log("");
}

main().catch((e) => { console.error("\nFATAL:", e?.message || e); if (e?.logs) console.error(e.logs); process.exit(1); });
