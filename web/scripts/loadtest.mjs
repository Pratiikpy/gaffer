/** K7 — load test for the synchronized fan-out.
 *
 * The Frozen Window's whole promise is that a room of people all see the same thing at the same second.
 * That is the moment the app is most likely to fall over: every phone polls the same endpoint at once.
 * "By the fifth question the app abruptly logged me out" is what failing this looks like to a fan.
 *
 * This drives N virtual clients at the endpoints a live window actually hits, measures the latency
 * distribution and the error rate, and prints a verdict against explicit budgets. It reports what it did
 * NOT cover, because a load test that quietly narrows its own scope is worse than none.
 *
 * Usage:
 *   node scripts/loadtest.mjs                       # 50 clients, 20s
 *   CLIENTS=200 SECONDS=30 BASE=https://… node scripts/loadtest.mjs
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CLIENTS = Number(process.env.CLIENTS || 50);
const SECONDS = Number(process.env.SECONDS || 20);
const POLL_MS = Number(process.env.POLL_MS || 2000);
const FIXTURE = Number(process.env.FIXTURE || 0);

// Budgets. A window that takes longer than this to paint is a window nobody experiences together.
const BUDGET = { p95Ms: 1500, p99Ms: 3000, errorRate: 0.01 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);

async function pickFixture() {
  if (FIXTURE) return FIXTURE;
  const r = await fetch(`${BASE}/api/fixtures`).then((x) => x.json()).catch(() => null);
  const list = r?.fixtures || [];
  const live = list.find((f) => f.state === "live") || list.find((f) => f.state === "soon") || list[0];
  return live ? Number(live.fixtureId) : 0;
}

/** The endpoints a phone actually hits while a Frozen Window is open. */
function endpoints(fixture) {
  return [
    { name: "rounds", url: `${BASE}/api/rounds?fixture=${fixture}` },
    { name: "live", url: `${BASE}/api/live?fixture=${fixture}` },
    { name: "markets", url: `${BASE}/api/markets` },
  ];
}

const stats = new Map();   // name → { lat: number[], errors: number, n: number }
const record = (name, ms, ok) => {
  let s = stats.get(name);
  if (!s) { s = { lat: [], errors: 0, n: 0 }; stats.set(name, s); }
  s.n++; if (ok) s.lat.push(ms); else s.errors++;
};

async function hit(ep) {
  const t0 = performance.now();
  try {
    const res = await fetch(ep.url, { cache: "no-store" });
    const ms = performance.now() - t0;
    // A 429 is the system defending itself, not a crash — counted separately from a real failure.
    if (res.status === 429) { record(ep.name, ms, true); return "throttled"; }
    record(ep.name, ms, res.ok);
    await res.arrayBuffer();                       // pay the body cost, like a real client
    return res.ok ? "ok" : `http ${res.status}`;
  } catch (e) {
    record(ep.name, performance.now() - t0, false);
    return "network";
  }
}

async function client(fixture, until) {
  const eps = endpoints(fixture);
  // Jitter the first poll so N clients don't align into a thundering herd we didn't intend to test.
  await sleep(Math.random() * POLL_MS);
  while (Date.now() < until) {
    await Promise.all(eps.map(hit));
    await sleep(POLL_MS);
  }
}

async function main() {
  const fixture = await pickFixture();
  if (!fixture) { console.error("no fixture available to test against"); process.exit(1); }

  console.log(`load test · ${CLIENTS} clients · ${SECONDS}s · fixture ${fixture} · ${BASE}`);
  console.log(`endpoints: ${endpoints(fixture).map((e) => e.name).join(", ")}\n`);

  const until = Date.now() + SECONDS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CLIENTS }, () => client(fixture, until)));
  const elapsed = (Date.now() - t0) / 1000;

  let failed = false;
  let totalReq = 0, totalErr = 0;
  console.log("endpoint        n     p50      p95      p99      max     errors");
  for (const [name, s] of stats) {
    s.lat.sort((a, b) => a - b);
    const p50 = pct(s.lat, 50), p95 = pct(s.lat, 95), p99 = pct(s.lat, 99), max = s.lat[s.lat.length - 1] ?? 0;
    const er = s.n ? s.errors / s.n : 0;
    totalReq += s.n; totalErr += s.errors;
    if (p95 > BUDGET.p95Ms || p99 > BUDGET.p99Ms || er > BUDGET.errorRate) failed = true;
    console.log(
      `${name.padEnd(14)} ${String(s.n).padStart(5)} ${p50.toFixed(0).padStart(6)}ms ${p95.toFixed(0).padStart(6)}ms ` +
      `${p99.toFixed(0).padStart(6)}ms ${max.toFixed(0).padStart(6)}ms ${(er * 100).toFixed(2).padStart(7)}%`,
    );
  }

  console.log(`\n${totalReq} requests in ${elapsed.toFixed(1)}s · ${(totalReq / elapsed).toFixed(0)} req/s · ${totalErr} errors`);
  console.log(`budget: p95 ≤ ${BUDGET.p95Ms}ms · p99 ≤ ${BUDGET.p99Ms}ms · errors ≤ ${(BUDGET.errorRate * 100).toFixed(0)}%`);
  console.log(failed ? "VERDICT: OVER BUDGET" : "VERDICT: within budget");

  // Say plainly what this run did not cover, so nobody reads it as more than it is.
  console.log("\nnot covered by this run: the push fan-out (a real device is needed), on-chain settle" +
    " throughput (rate-limited by devnet, not by us), and a cold Neon start (the first request warms it).");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("load test failed:", e?.message || e); process.exit(1); });
