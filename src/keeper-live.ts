/** Live settlement keeper — unattended. Discovers every open market and cranks it through the
 * deployed permissionless settle endpoint (`/api/settle`), which itself discovers the anchored
 * TxLINE proof and fires the on-chain `settle`. This is the production keeper: ONE proven auth
 * path (the server txline singleton behind the route), no re-subscribe races, deterministic —
 * the keeper picks nothing about outcomes; `validate_stat` inside the kernel CPI decides.
 *
 * Run: `npx ts-node src/keeper-live.ts`  (BASE overridable; defaults to the local app).
 * Loops until no open market changes state for a full pass, then exits 0. Kept logs prove
 * unattended Track-3 operation.
 */
const BASE = process.env.KEEPER_BASE || "http://127.0.0.1:3000";
const MAX_PASSES = Number(process.env.KEEPER_PASSES || 6);
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 8000);

type Market = { pubkey: string; fixtureId: string; statKey: number; status: number; statusLabel: string };

async function openMarkets(): Promise<Market[]> {
  const r = await fetch(`${BASE}/api/markets`).then((x) => x.json());
  return (r.markets || []).filter((m: Market) => m.status === 0);
}

async function crank(market: string): Promise<{ settled: boolean; reason?: string; sig?: string; provenValue?: number }> {
  const r = await fetch(`${BASE}/api/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market }),
  }).then((x) => x.json());
  return r;
}

async function main() {
  const ts = () => new Date().toISOString();
  console.log(`[keeper] start ${ts()} · base ${BASE} · up to ${MAX_PASSES} passes`);
  let totalSettled = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const open = await openMarkets();
    if (!open.length) {
      console.log(`[keeper] pass ${pass} ${ts()} — no open markets; done.`);
      break;
    }
    let settledThisPass = 0;
    for (const m of open) {
      const r = await crank(m.pubkey);
      if (r.settled) {
        settledThisPass++; totalSettled++;
        console.log(`[keeper] pass ${pass} ${ts()} · SETTLED ${m.pubkey.slice(0, 8)}… fixture ${m.fixtureId} statKey ${m.statKey} → provenValue ${r.provenValue} · ${r.sig?.slice(0, 12)}…`);
      } else {
        console.log(`[keeper] pass ${pass} ${ts()} · skip ${m.pubkey.slice(0, 8)}… — ${r.reason}`);
      }
    }
    console.log(`[keeper] pass ${pass} summary: ${settledThisPass}/${open.length} settled (${totalSettled} total)`);
    // If a whole pass settled nothing, the rest are waiting on their fixtures — stop cleanly.
    if (settledThisPass === 0) { console.log(`[keeper] no progress this pass — remaining markets await their fixtures. Exiting.`); break; }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
  console.log(`[keeper] end ${ts()} · ${totalSettled} market(s) settled autonomously this run.`);
}

main().catch((e) => { console.error("[keeper] FAIL:", e?.message || e); process.exit(1); });
