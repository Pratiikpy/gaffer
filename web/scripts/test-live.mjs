/** Live-match rule tests (L2 silence detector, L7 halftime detection).
 * Pure logic — no feed, no DB. Mirrors src/lib/rounds.ts `computeSilence` and src/lib/live.ts `liveState`.
 * Run: `node scripts/test-live.mjs` */
import assert from "node:assert";

let n = 0, pass = 0;
const t = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };
/** Async-aware. The sync runner above would let a rejected promise slip through as a pass. */
const ta = async (name, fn) => { n++; try { await fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };

/* ── L2 · odds-silence bookkeeping (mirror of rounds.ts computeSilence) ── */
function computeSilence(prev, id, now) {
  if (!id) return { silentMs: 0, next: prev };
  if (!prev || prev.messageId !== id) return { silentMs: 0, next: { messageId: id, since: now } };
  return { silentMs: now - prev.since, next: prev };
}
const SILENCE_MS = 30_000;

console.log("L2 · odds-silence detector:");
t("a brand-new message starts the clock at zero", () => {
  const r = computeSilence(undefined, "m1", 1000);
  assert.strictEqual(r.silentMs, 0);
  assert.deepStrictEqual(r.next, { messageId: "m1", since: 1000 });
});
t("the same message id accrues silence", () => {
  const r = computeSilence({ messageId: "m1", since: 1000 }, "m1", 26_000);
  assert.strictEqual(r.silentMs, 25_000);
});
t("a new message id resets the clock (the market spoke)", () => {
  const r = computeSilence({ messageId: "m1", since: 1000 }, "m2", 40_000);
  assert.strictEqual(r.silentMs, 0);
  assert.deepStrictEqual(r.next, { messageId: "m2", since: 40_000 });
});
t("no quote at all is NOT silence (absence != silence)", () => {
  const r = computeSilence({ messageId: "m1", since: 1000 }, null, 99_000);
  assert.strictEqual(r.silentMs, 0, "a book quoting nothing must not trip a Blackout");
  assert.deepStrictEqual(r.next, { messageId: "m1", since: 1000 }, "watch is preserved");
});
t("trips only at or past the threshold", () => {
  const prev = { messageId: "m1", since: 0 };
  assert.ok(computeSilence(prev, "m1", SILENCE_MS - 1).silentMs < SILENCE_MS, "29.999s must not trip");
  assert.ok(computeSilence(prev, "m1", SILENCE_MS).silentMs >= SILENCE_MS, "30s trips");
});

/* ── L7 · halftime detection (mirror of live.ts liveState) ── */
const HT = [2700, 3000];
function halftime({ finished, running, clockSeconds }) {
  const inBand = clockSeconds != null && clockSeconds >= HT[0] && clockSeconds <= HT[1];
  return !finished && !running && inBand;
}
function secondHalf(clockSeconds) { return clockSeconds != null && clockSeconds > HT[1]; }

console.log("L7 · halftime detection:");
t("clock stopped at 45:00 is halftime", () => assert.strictEqual(halftime({ finished: false, running: false, clockSeconds: 2700 }), true));
t("clock stopped at 47:30 (stoppage) is still halftime", () => assert.strictEqual(halftime({ finished: false, running: false, clockSeconds: 2850 }), true));
t("clock RUNNING at 45:00 is not halftime", () => assert.strictEqual(halftime({ finished: false, running: true, clockSeconds: 2700 }), false));
t("a finished match is never halftime", () => assert.strictEqual(halftime({ finished: true, running: false, clockSeconds: 2800 }), false));
t("stopped at 20:00 (an injury break) is not halftime", () => assert.strictEqual(halftime({ finished: false, running: false, clockSeconds: 1200 }), false));
t("stopped at 90:00 (full time) is not halftime", () => assert.strictEqual(halftime({ finished: false, running: false, clockSeconds: 5400 }), false));
t("unknown clock is never halftime", () => assert.strictEqual(halftime({ finished: false, running: false, clockSeconds: null }), false));
t("past the band is second half", () => { assert.strictEqual(secondHalf(3001), true); assert.strictEqual(secondHalf(2999), false); });

/* ── The scoreline must survive a feed blip ──
 * readLiveState() throws on a failed feed call so cached() can serve the last good value. It used to
 * swallow the error and return an empty state, which the cache then stored AS DATA for up to thirty
 * seconds — blanking the score mid-match. A feed that answers with nothing is a different thing, and
 * must still render as unknown rather than as 0–0. */
const scoreOf = (s) => (s.homeGoals == null ? "unknown" : `${s.homeGoals}-${s.awayGoals}`);
const EMPTY = { homeGoals: null, awayGoals: null };
const LIVE_2_0 = { homeGoals: 2, awayGoals: 0 };

/** A miniature of cache.ts: store on success, serve last-good on throw, rethrow once too stale. */
function makeLiveCache(readFn) {
  let entry;
  return async function liveState(now, staleMs = 60_000) {
    try {
      const value = await readFn();
      entry = { at: now, value };
      return value;
    } catch (e) {
      if (entry && now - entry.at < staleMs) return entry.value;
      throw e;
    }
  };
}

console.log("scoreline resilience:");
{
  let mode = "ok";
  const read = async () => {
    if (mode === "throw") throw new Error("feed down");
    return mode === "empty" ? EMPTY : LIVE_2_0;
  };
  const liveState = makeLiveCache(read);

  await ta("a healthy feed shows the score", async () => assert.strictEqual(scoreOf(await liveState(0)), "2-0"));

  mode = "throw";
  await ta("a feed blip keeps the last good score on screen, never a blank", async () =>
    assert.strictEqual(scoreOf(await liveState(5_000)), "2-0"));

  await ta("an outage past staleMs surfaces the failure rather than inventing a state", async () => {
    let threw = false;
    try { await liveState(90_000); } catch { threw = true; }
    assert.strictEqual(threw, true);
  });

  mode = "empty";
  await ta("a fixture the feed knows nothing about renders as unknown, never 0-0", async () =>
    assert.strictEqual(scoreOf(await liveState(100_000)), "unknown"));

  mode = "ok";
  await ta("and it recovers the moment the feed returns", async () =>
    assert.strictEqual(scoreOf(await liveState(101_000)), "2-0"));
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
