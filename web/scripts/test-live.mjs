/** Live-match rule tests (L2 silence detector, L7 halftime detection).
 * Pure logic — no feed, no DB. Mirrors src/lib/rounds.ts `computeSilence` and src/lib/live.ts `liveState`.
 * Run: `node scripts/test-live.mjs` */
import assert from "node:assert";

let n = 0, pass = 0;
const t = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };

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

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
