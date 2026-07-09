/** Live settlement keeper — unattended, and production-shaped (K5).
 *
 * It cranks every open market through the deployed permissionless settle endpoint, which itself finds the
 * anchored TxLINE proof and fires the on-chain `settle`. The keeper decides nothing about outcomes;
 * `validate_stat` inside the kernel CPI does.
 *
 * What "productionized" means here, and why:
 *  - **Priority by stake.** The biggest pot is the one somebody is refreshing. Settle it first.
 *  - **Parallelism, bounded.** A sequential sweep of forty markets means the last winner waits forty
 *    round-trips. A bounded pool keeps wall-clock down without stampeding the RPC or the feed.
 *  - **Proof caching.** Handled server-side per (fixture, stat), so markets on the same match share one
 *    discovery instead of repeating it each.
 *  - **Idempotent and restart-safe.** State lives on-chain; a settled market simply reports "not open".
 *  - **Backs off on throttle.** The settle route rate-limits per IP; hitting it is not an error, it is a
 *    signal to slow down.
 *
 * Run: `npx ts-node src/keeper-live.ts`
 */
const BASE = process.env.KEEPER_BASE || "http://127.0.0.1:3000";
const MAX_PASSES = Number(process.env.KEEPER_PASSES || 6);
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 8000);
const CONCURRENCY = Number(process.env.KEEPER_CONCURRENCY || 4);
const ADMIN_KEY = process.env.GAFFER_ADMIN_KEY || "";

type Market = { pubkey: string; fixtureId: string; statKey: number; status: number; potSol?: number };
type Result = { settled: boolean; reason?: string; sig?: string; provenValue?: number; throttled?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

async function openMarkets(): Promise<Market[]> {
  const r = await fetch(`${BASE}/api/markets`).then((x) => x.json());
  return (r.markets || []).filter((m: Market) => m.status === 0);
}

async function crank(market: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ADMIN_KEY ? { "x-admin-key": ADMIN_KEY } : {}) },
    body: JSON.stringify({ market }),
  });
  if (res.status === 429) return { settled: false, reason: "throttled", throttled: true };
  return (await res.json()) as Result;
}

/** Run `work` over `items` with at most `limit` in flight. Order of completion doesn't matter; order of
 * STARTING does — items arrive already sorted by stake, and workers take the next one each time. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`[keeper] start ${ts()} · base ${BASE} · concurrency ${CONCURRENCY} · up to ${MAX_PASSES} passes`);
  let totalSettled = 0;
  let backoff = INTERVAL_MS;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const open = await openMarkets();
    if (!open.length) { console.log(`[keeper] pass ${pass} ${ts()} — no open markets; done.`); break; }

    // Priority by stake: the biggest pot has the most people waiting on it.
    open.sort((a, b) => Number(b.potSol ?? 0) - Number(a.potSol ?? 0));

    let settled = 0, throttled = 0, skipped = 0;
    const results = await pool(open, CONCURRENCY, async (m) => {
      const r = await crank(m.pubkey);
      if (r.settled) {
        settled++;
        console.log(`[keeper] pass ${pass} ${ts()} · SETTLED ${m.pubkey.slice(0, 8)}… fixture ${m.fixtureId} statKey ${m.statKey} pot ${m.potSol ?? "?"} → provenValue ${r.provenValue} · ${r.sig?.slice(0, 12)}…`);
      } else if (r.throttled) { throttled++; }
      else { skipped++; }
      return r;
    });
    totalSettled += settled;

    // Report what was NOT settled, grouped — silence about skipped work reads as "covered everything".
    const reasons = new Map<string, number>();
    for (const r of results) if (!r.settled && !r.throttled && r.reason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    const why = [...reasons.entries()].map(([k, v]) => `${v}× ${k}`).join(", ");
    console.log(`[keeper] pass ${pass} summary: ${settled} settled, ${skipped} waiting (${why || "—"}), ${throttled} throttled (${totalSettled} total)`);

    if (throttled > 0) {
      // Being rate-limited is a signal, not a failure. Back off, then try the rest.
      backoff = Math.min(backoff * 2, 60_000);
      console.log(`[keeper] throttled — backing off ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }
    backoff = INTERVAL_MS;
    if (settled === 0) { console.log(`[keeper] no progress this pass — the rest await their fixtures. Exiting.`); break; }
    await sleep(INTERVAL_MS);
  }
  console.log(`[keeper] end ${ts()} · ${totalSettled} market(s) settled autonomously this run.`);
}

main().catch((e) => { console.error("[keeper] FAIL:", e?.message || e); process.exit(1); });
