/** Cache tests: single-flight, TTL, stale-while-revalidate, and the bug that made /api/rounds 500 —
 * a background refresh parked in the single-flight map handing `undefined` to a mid-refresh reader.
 * Mirrors src/lib/cache.ts. Run: `node scripts/test-cache.mjs` */
import assert from "node:assert";

let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCache() {
  const store = new Map();
  const inflight = new Map();

  function refresh(key, fn) {
    const p = (async () => {
      try { const value = await fn(); store.set(key, { at: Date.now(), value }); return value; }
      catch { return store.get(key)?.value; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }

  async function cached(key, opts, fn) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now - hit.at < opts.ttlMs) return hit.value;
    if (hit && opts.swrMs && now - hit.at < opts.swrMs) {
      if (!inflight.has(key)) void refresh(key, fn);
      return hit.value;
    }
    const flying = inflight.get(key);
    if (flying) { const v = await flying; if (v !== undefined) return v; }
    const p = (async () => {
      try { const value = await fn(); store.set(key, { at: Date.now(), value }); return value; }
      catch (e) {
        const stale = store.get(key);
        if (stale && opts.staleMs && Date.now() - stale.at < opts.staleMs) return stale.value;
        throw e;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  return { cached, store, inflight };
}

console.log("single-flight:");
{
  const { cached } = makeCache();
  let calls = 0;
  const fn = async () => { calls++; await sleep(40); return { v: 1 }; };
  const rs = await Promise.all(Array.from({ length: 20 }, () => cached("k", { ttlMs: 1000 }, fn)));
  t("20 concurrent readers cause exactly one upstream call", calls === 1, `calls=${calls}`);
  t("all 20 get the value", rs.every((r) => r && r.v === 1));
}

console.log("TTL:");
{
  const { cached } = makeCache();
  let calls = 0;
  const fn = async () => { calls++; return calls; };
  await cached("k", { ttlMs: 50 }, fn);
  await cached("k", { ttlMs: 50 }, fn);
  t("a fresh value skips upstream", calls === 1);
  await sleep(70);
  await cached("k", { ttlMs: 50 }, fn);
  t("an expired value refetches", calls === 2);
}

console.log("stale-while-revalidate — the /api/rounds 500 regression:");
{
  const { cached } = makeCache();
  let calls = 0;
  const fn = async () => { calls++; await sleep(60); return { n: calls }; };

  await cached("k", { ttlMs: 10, swrMs: 5000 }, fn);   // prime
  await sleep(30);                                      // now stale-but-serveable

  // This read triggers a BACKGROUND refresh and returns the stale value immediately…
  const first = await cached("k", { ttlMs: 10, swrMs: 5000 }, fn);
  t("a stale read returns instantly with the old value", first && first.n === 1);

  // …and this read arrives WHILE that refresh is in flight. It used to await a Promise<void>
  // and receive `undefined`, which the route then failed to serialise.
  await sleep(5);
  const during = await cached("k", { ttlMs: 10, swrMs: 5000 }, fn);
  t("a read during a background refresh never returns undefined", during !== undefined, `got ${during}`);
  t("and it returns a real value", during && typeof during.n === "number", JSON.stringify(during));
}

console.log("failure handling:");
{
  const { cached } = makeCache();
  let calls = 0;
  const fn = async () => { calls++; if (calls > 1) throw new Error("upstream down"); return "good"; };
  await cached("k", { ttlMs: 1, staleMs: 5000 }, fn);
  await sleep(10);
  const v = await cached("k", { ttlMs: 1, staleMs: 5000 }, fn);
  t("a failed refetch serves the last good value", v === "good");

  const { cached: c2 } = makeCache();
  let threw = false;
  try { await c2("k", { ttlMs: 1, staleMs: 5000 }, async () => { throw new Error("cold fail"); }); } catch { threw = true; }
  t("a failure with nothing cached still throws (never a silent undefined)", threw);
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
