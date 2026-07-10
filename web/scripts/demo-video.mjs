#!/usr/bin/env node
/**
 * Record the demo, by playing the real product.
 *
 * The submission is judged heavily on a demo video, and a video is the one artefact that cannot be
 * faked into existence: it either shows a fan asking a question, backing a call, and being paid, or it
 * doesn't. So this drives the deployed app in a real browser, at phone size, and films what happens.
 * Nothing is stubbed, nothing is drawn on top. Every pool it opens is minted on-chain by the browser's
 * own wallet; every payout it collects is a real transaction.
 *
 * It also prints a chapter list with timestamps, so the cut is a matter of trimming rather than hunting.
 *
 *   node scripts/demo-video.mjs                        # films production
 *   node scripts/demo-video.mjs --base http://127.0.0.1:3001
 *   node scripts/demo-video.mjs --keep-storage         # don't reset; film as a returning fan
 *
 * Output: demo/gaffer-<timestamp>.webm plus a still per chapter.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = (process.env.BASE || arg("base", "https://gaffer-cyan.vercel.app")).replace(/\/$/, "");
const FRESH = !process.argv.includes("--keep-storage");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(ROOT, "demo", STAMP);
mkdirSync(OUT, { recursive: true });

const started = Date.now();
const chapters = [];
const chapter = async (page, name) => {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  chapters.push({ at, name });
  console.log(`  ${String(at).padStart(6)}s  ${name}`);
  await page.screenshot({ path: resolve(OUT, `${chapters.length.toString().padStart(2, "0")}-${name.replace(/\W+/g, "-")}.png`) });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `fn` to return truthy, or explain what never happened. */
async function until(page, label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await sleep(700);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const text = (page) => page.evaluate(() => document.body.innerText);

const clickByText = async (page, label, exact = true) => {
  const ok = await page.evaluate(({ label, exact }) => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      exact ? x.textContent.trim() === label : x.textContent.includes(label));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  }, { label, exact });
  if (!ok) throw new Error(`no clickable button: ${label}`);
};

// Arrive the way a fan actually arrives: on a link a mate sent. `?pool=` selects that pool's match, so
// the film opens on a real scoreline rather than on whichever fixture the app happened to default to.
const hero = await fetch(`${BASE}/api/markets`).then((r) => r.json()).then((d) =>
  d.markets.find((m) => m.status === 0 && m.fixtureId === "18172379" && m.statKey === 1 && m.threshold === 0));
if (!hero) throw new Error("no open hero pool — run POST /api/provision-hero first");
const ENTRY = `${BASE}/?pool=${hero.pubkey}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  console.log(`filming ${BASE} → ${OUT}\n`);

  // ── 1. Arrive. No account, no gate, and the score is the first thing you see. ────────────────────
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  if (FRESH) { await page.evaluate(() => localStorage.clear()); await page.goto(ENTRY, { waitUntil: "domcontentloaded" }); }
  await until(page, "the app to settle", () => document.querySelectorAll("button").length > 5);
  await sleep(3500);
  await chapter(page, "arrive - a mate sent you this call, no signup wall");

  const t0 = await text(page);
  if (/let me in|before you back it/i.test(t0)) throw new Error("an age gate met a first-time visitor");

  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "skip"); if (b) b.click(); });
  await sleep(1800);
  // The shared link opens that pool's sheet. Close it; we come back to it deliberately later.
  await page.evaluate(() => { const c = document.querySelector('button[aria-label="Close"]'); if (c) c.click(); });
  await sleep(2200);
  await until(page, "the live scoreline", () => /\d+\s*–\s*\d+/.test(document.body.innerText));
  await chapter(page, "the score, above the fold");

  // A first-time device is spotted play-coins from the faucet. Nothing can be minted until they land.
  await until(page, "the faucet to fund this device", async () => {
    const r = await fetch("/api/markets").then((x) => x.json()).catch(() => null);
    return !!r;
  }, 20_000);
  await sleep(9000);

  // ── 2. Ask your own question. The model proposes; the grammar disposes; your wallet mints it. ────
  const askSel = 'input[aria-label="Ask your own question about this match"]';
  await page.locator(askSel).scrollIntoViewIfNeeded();
  await sleep(1200);
  await page.locator(askSel).click();
  await page.locator(askSel).type("Bosnia to bag a hat-trick", { delay: 55 });
  await sleep(900);
  await chapter(page, "ask it how youd say it to a mate");

  await clickByText(page, "Open it");
  // The gate stands here, at the money — and it runs the action it interrupted.
  await until(page, "the 18+ gate at the money", () => /before you back it/i.test(document.body.innerText), 25_000);
  await sleep(1600);
  await chapter(page, "the age gate stands at the money not the door");
  await clickByText(page, "put my call on", false);

  // Wait for the CARD, not for a toast that mentions it — and put it on screen. A frame that claims a
  // pool was opened has to show the pool.
  await until(page, "the pool card the fan just minted", () => {
    const card = [...document.querySelectorAll("div")].find((d) =>
      typeof d.className === "string" && d.className.includes("rounded-2xl") &&
      /3\+ goals\?/.test(d.innerText) &&
      [...d.querySelectorAll("button")].some((b) => b.textContent.trim() === "YES"));
    if (!card) return false;
    card.scrollIntoView({ block: "center" });
    return true;
  }, 120_000);
  await sleep(2400);
  await chapter(page, "a pool the fan opened, minted by their own wallet");

  // ── 3. Back a call, and watch what it pays. ──────────────────────────────────────────────────────
  const opened = await page.evaluate(() => {
    const card = [...document.querySelectorAll("div")].find((d) =>
      typeof d.className === "string" && d.className.includes("rounded-2xl") &&
      /USA to score\?/.test(d.innerText) && [...d.querySelectorAll("button")].some((b) => b.textContent.trim() === "YES"));
    if (!card) return false;
    card.scrollIntoView({ block: "center" });
    [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "YES").click();
    return true;
  });
  if (!opened) throw new Error("no open hero pool to back");
  await until(page, "the call sheet", () => /If it lands you win/.test(document.body.innerText));
  await sleep(2600);
  await chapter(page, "risk this, win that");

  await clickByText(page, "Lock in", false);
  await until(page, "the call to lock in", () => /You.re riding/i.test(document.body.innerText), 60_000);
  await sleep(2400);
  await chapter(page, "locked in");

  // The settler, off-camera. It is the same unattended keeper that runs through a real match; nudging it
  // here only saves the film from waiting on the nightly cron. It decides nothing — `validate_stat` does.
  if (process.env.GAFFER_ADMIN_KEY) {
    fetch(`${BASE}/api/keeper?fixture=18172379`, { method: "POST", headers: { "x-gaffer-key": process.env.GAFFER_ADMIN_KEY } })
      .then((r) => console.log(`  (keeper swept: ${r.status})`))
      .catch(() => {});
  }

  // ── 4. The whistle. Nobody presses anything; the keeper settles it, and the fan collects. ────────
  await until(page, "the pool to settle and offer a collect",
    () => /Collect your winnings/.test(document.body.innerText), 240_000);
  await sleep(1800);
  await chapter(page, "settled on the proof - ready to collect");

  await clickByText(page, "Collect your winnings", false);
  await until(page, "the payout receipt", () => /VERIFIED|it.s yours/i.test(document.body.innerText), 90_000);
  await sleep(3800);
  await chapter(page, "paid - proof of payout");

  console.log("\nchapters:");
  for (const c of chapters) console.log(`  ${String(c.at).padStart(6)}s  ${c.name}`);
  writeFileSync(resolve(OUT, "chapters.json"), JSON.stringify({ base: BASE, chapters, consoleErrors: errors }, null, 2));
  if (errors.length) console.log(`\nconsole errors during the take: ${errors.length}\n  ` + errors.slice(0, 5).join("\n  "));
  else console.log("\nconsole errors during the take: 0");
} catch (e) {
  await page.screenshot({ path: resolve(OUT, "FAILED.png") }).catch(() => {});
  console.error("\nTAKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await context.close();   // flushes the video
  await browser.close();
  console.log(`\nvideo + stills → ${OUT}`);
}
