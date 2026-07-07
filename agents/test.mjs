#!/usr/bin/env node
/**
 * Combined agent test suite (Track 3) — edge-case coverage over every agent's deterministic core,
 * beyond each agent's own --selftest. Run: `node test.mjs`. Deterministic, no network.
 */
import assert from "node:assert";
import { detectMove } from "./detector.mjs";
import { runArena, pickSide, winner } from "./arena.mjs";
import { quote, onEvent, fairPrice } from "./market-maker.mjs";
import { clv, summarize } from "./clv-tracker.mjs";

let n = 0, pass = 0;
const t = (name, fn) => { n++; try { fn(); pass++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "—", e.message); } };

console.log("Detector:");
t("flags a move exactly at threshold", () => assert.strictEqual(detectMove({ home: 20, draw: 30, away: 50 }, { home: 25, draw: 30, away: 45 }, 5).move, 5));
t("ignores a sub-threshold move", () => assert.strictEqual(detectMove({ home: 20, draw: 30, away: 50 }, { home: 24, draw: 30, away: 46 }, 5), null));
t("cold start returns null", () => assert.strictEqual(detectMove(null, { home: 1, draw: 1, away: 1 }), null));

console.log("Arena:");
t("winner() reads a draw", () => assert.strictEqual(winner({ home: 1, away: 1 }), "draw"));
t("pickSide favorite vs underdog are opposite", () => { const o = { home: 60, draw: 25, away: 15 }; assert.notStrictEqual(pickSide("favorite", o), pickSide("underdog", o)); });
t("runArena returns a stable lead + full W/L", () => { const r = runArena([{ odds: { home: 60, draw: 25, away: 15 }, result: { home: 2, away: 0 } }]); assert(r.lead && r.record.favorite.w + r.record.favorite.l === 1); });

console.log("Market Maker:");
t("clamps a 1% fair to a valid bid", () => assert(quote(1).bid >= 0.01));
t("clamps a 99% fair to a valid ask", () => assert(quote(99).ask <= 0.99));
t("pulls quotes on a VAR event", () => assert.strictEqual(onEvent("var"), null));
t("holds on a throw-in", () => assert.strictEqual(onEvent("throw_in"), "hold"));

console.log("CLV:");
t("negative when the market moves away", () => assert.strictEqual(clv(50, 44), -6));
t("summarize is safe on empty input", () => assert.strictEqual(summarize([]).count, 0));
t("beat-rate counts only positive CLV", () => assert.strictEqual(summarize([{ entryPct: 30, closePct: 35 }, { entryPct: 40, closePct: 38 }]).beatRate, 0.5));

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
