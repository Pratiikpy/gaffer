/** Single-flight caching, for the synchronized fan-out.
 *
 * The Frozen Window's promise is that a room sees the same thing at the same second — which means the
 * server gets N identical requests in the same instant. Without coalescing, each one starts its own
 * upstream fetch: forty clients become forty TxLINE calls and forty `getProgramAccounts`, the RPC starts
 * refusing us, and the moment everyone was supposed to share is the moment the app falls over.
 *
 * `cached()` does two things, and they matter in this order:
 *   1. **Single-flight.** While one fetch is in the air, every other caller awaits THAT promise. N
 *      concurrent readers cause exactly one upstream call.
 *   2. **TTL.** A fresh-enough value is returned without touching upstream at all.
 *
 * On failure we keep serving the last good value until `staleMs`, because a slightly old score beats an
 * error page — but we never serve stale data as if it were fresh, and we never cache an error.
 */
type Entry<T> = { at: number; value: T } | undefined;

const store = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export type CacheOpts = {
  ttlMs: number;
  staleMs?: number;
  /** Serve a value this old immediately and refresh behind it. Nobody should wait for a refresh: with a
   *  plain TTL, the one client unlucky enough to arrive at expiry pays the whole upstream cost, and that
   *  shows up as the p95 everyone remembers. */
  swrMs?: number;
};

export async function cached<T>(key: string, opts: CacheOpts, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T>;
  if (hit && now - hit.at < opts.ttlMs) return hit.value;

  // Stale-while-revalidate: hand back the old value now, kick the refresh off behind it.
  if (hit && opts.swrMs && now - hit.at < opts.swrMs) {
    if (!inflight.has(key)) void refresh(key, fn);
    return hit.value;
  }

  // Someone is already fetching this exact key — wait for them rather than starting a second one.
  const flying = inflight.get(key) as Promise<T> | undefined;
  if (flying) return flying;

  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      // Serve the last good value through a blip, if it's not too old. Never cache the failure.
      const stale = store.get(key) as Entry<T>;
      if (stale && opts.staleMs && Date.now() - stale.at < opts.staleMs) return stale.value;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Refresh a key in the background. A failed background refresh is silent: the stale value still stands,
 * and the next foreground miss will surface the error properly. */
function refresh<T>(key: string, fn: () => Promise<T>): Promise<void> {
  const p = (async () => {
    try { const value = await fn(); store.set(key, { at: Date.now(), value }); }
    catch { /* keep the stale value; do not cache the failure */ }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p as Promise<unknown>);
  return p;
}

/** Drop a key (or everything) — used by tests and by writes that invalidate a read. */
export function invalidate(key?: string) {
  if (key) { store.delete(key); inflight.delete(key); }
  else { store.clear(); inflight.clear(); }
}

/** Visible for tests: how many upstream calls a key has actually made. */
export const cacheStats = { get size() { return store.size; }, get inflight() { return inflight.size; } };
