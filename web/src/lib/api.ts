"use client";
import type { MarketView } from "./kernel";

export async function getMarkets(): Promise<MarketView[]> {
  const r = await fetch("/api/markets", { cache: "no-store" });
  return (await r.json()).markets || [];
}
export async function getScores(fixtureId: string | number): Promise<any> {
  const r = await fetch(`/api/scores/${fixtureId}`, { cache: "no-store" });
  return await r.json();
}
export async function createMarket(body: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/create-market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}
export async function fundWallet(pubkey: string): Promise<any> {
  const r = await fetch("/api/fund", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pubkey }) });
  return await r.json();
}
export async function squad(action: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/squad", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  return await r.json();
}
/** The squad, plus commissioner settings, the lore wall, and (when `user` is given) that fan's duels. */
export async function squadGet(code: string, user?: string): Promise<any> {
  const q = user ? `?user=${encodeURIComponent(user)}` : "";
  const r = await fetch(`/api/squad/${code}${q}`, { cache: "no-store" });
  return r.ok ? await r.json() : null;
}
/** Server-authoritative points. `action` = free_pick | stake | win | share; the server decides the
 * amount and verifies money grants on-chain. The client only ever asks, never sets a total. */
export async function points(action: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/points", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  return r.ok ? await r.json() : null;
}
export async function pointsGet(user: string): Promise<any> {
  const r = await fetch(`/api/points?user=${encodeURIComponent(user)}`, { cache: "no-store" });
  return r.ok ? await r.json() : null;
}
export async function streakGrid(user: string): Promise<{ cells: ("hit" | "freeze" | "miss")[]; streak: number; alivePct: number | null } | null> {
  const r = await fetch(`/api/streak-grid?user=${encodeURIComponent(user)}`, { cache: "no-store" });
  return r.ok ? await r.json() : null;
}

/** L5/L7/L8 — the live pulse of a match: clock, halftime, whether the market has gone quiet, your open
 * call, and whether the one-per-matchday move is available right now. */
export type LivePulse = {
  fixtureId: number; finished: boolean; clockSeconds: number | null; running: boolean;
  atHalftime: boolean; secondHalf: boolean;
  silentMs: number; silenceThresholdMs: number; marketQuiet: boolean;
  pick: { fixtureId: number; side: string; quest: string } | null;
  canTwist: boolean;
};
export async function livePulse(fixture: number, user?: string, squad?: string | null): Promise<LivePulse | null> {
  const q = new URLSearchParams({ fixture: String(fixture) });
  if (user) q.set("user", user);
  if (squad) q.set("squad", squad);
  const r = await fetch(`/api/live?${q}`, { cache: "no-store" });
  return r.ok ? await r.json() : null;
}
/** L8 — twist today's free call to the other side. One move per matchday, halftime only. */
export async function twistCall(payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return await r.json().catch(() => null);
}

/** The server-derived economy: tier, weekly league, quests + medals, percentile, wager, milestones,
 * boosters, foresight record, rollover pot, biggest wins. Pass no user for the public numbers only. */
export type Economy = {
  points: number; lifetimeEarned: number;
  tier: { name: string; index: number; next: string | null; toNext: number; pct: number };
  tiersAll: { name: string; min: number }[];
  streak: number; freezes: number;
  league: { league: number; rank: number; size: number; weekStart: number; rows: { userId: string; points: number; rank: number; you: boolean }[] };
  percentileToday: number | null; medalToday: "gold" | "silver" | "bronze" | null;
  quests: { quests: { id: string; label: string; done: boolean }[]; done: number; total: number; medal: "gold" | "silver" | "bronze" | null };
  weeklyBoard: { items: { id: string; label: string; done: boolean; endowed?: boolean }[]; done: number; total: number };
  wager: { status: string; startDay: number; stake: number; payout: number; targetDays: number } | null;
  wagerTerms: { stake: number; payout: number; targetDays: number };
  milestones: number[]; milestoneReached: number | null;
  boosters: {
    mystery: { revealed: boolean; name: string | null; blurb: string | null; revealsOn: string; armed: boolean; spent: boolean; used: boolean };
    move: { usedToday: boolean; ref: string | null };
  };
  foresight: { wins: number; losses: number; boldest: number | null; shotsOpened: number; shotsSealed: number };
  rollover: { lamports: number; sol: number; sources: number };
  biggestWins: { name: string; question: string; stake: number; payout: number; calledAt: number | null; settledAfterMs: number | null; ts: number }[];
  knockouts: { entered: boolean; open: boolean; startsOn: string; rank: number; size: number; rows: { userId: string; points: number; rank: number; you: boolean }[] } | null;
};
export async function economyGet(user?: string): Promise<Economy | null> {
  const q = user ? `?user=${encodeURIComponent(user)}` : "";
  const r = await fetch(`/api/economy${q}`, { cache: "no-store" });
  return r.ok ? await r.json() : null;
}
/** Economy spends/moves: open_wager | earn_back | use_move | use_mystery. Token-guarded server-side. */
export async function economyDo(action: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/economy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  return await r.json().catch(() => null);
}
/** Build the spoiler-free, paste-anywhere emoji grid string (Y2 — Wordle-style share physics). */
export function streakGridText(cells: ("hit" | "freeze" | "miss")[], streak: number, alivePct: number | null): string {
  const row = cells.map((c) => (c === "hit" ? "✅" : c === "freeze" ? "🧊" : "⬜")).join("");
  const tail = streak > 0
    ? `Still alive — ${streak}-day streak.${alivePct != null ? ` ${alivePct}% of the world isn't.` : ""}`
    : "Run's over. New one starts today.";
  return `${row}\n${tail}\nGAFFER`;
}
export async function getFixtures(): Promise<any[]> {
  const r = await fetch("/api/fixtures", { cache: "no-store" });
  return r.ok ? (await r.json()).fixtures || [] : [];
}
/** Live commercial-floor state from the on-chain Config PDA — today's rake (0), the cap, winnings-only. */
export async function getConfig(): Promise<{ rakeBps: number; maxRakeBps: number; onWinningsOnly: boolean }> {
  const r = await fetch("/api/config", { cache: "no-store" });
  return r.ok ? await r.json() : { rakeBps: 0, maxRakeBps: 500, onWinningsOnly: true };
}
/** Ensure open pools exist. No arg → the hero "USA to score" pool (minted fresh if the last was
 * collected). With a fixtureId → the standard home/away-to-score pair on that real scheduled match, so a
 * live fixture never greets a fan with "no pools". Idempotent + cheap when pools are already open. */
export async function provisionHero(fixtureId?: number): Promise<{ market?: string; markets?: string[]; created?: boolean } | null> {
  const r = await fetch("/api/provision-hero", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixtureId ? { fixtureId } : {}) });
  return r.ok ? await r.json() : null;
}
/** The Gaffer's Take — an AI pundit one-liner for a real match moment (always returns a line). */
export async function punditLine(payload: Record<string, unknown>): Promise<string> {
  try {
    const r = await fetch("/api/pundit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return r.ok ? (await r.json()).line || "" : "";
  } catch { return ""; }
}
/** Hi-Lo — deal a question over real match history / grade a guess (server-sealed answers). */
export async function hiloDeal(): Promise<{ qid: string; home: string; away: string; stat: string; threshold: number } | null> {
  const r = await fetch("/api/hilo", { cache: "no-store" });
  return r.ok ? await r.json() : null;
}
export async function hiloGuess(payload: Record<string, unknown>): Promise<{ correct: boolean; actual: number; answer: string; points: number | null } | null> {
  const r = await fetch("/api/hilo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return r.ok ? await r.json() : null;
}
export async function pushKey(): Promise<string> {
  const r = await fetch("/api/push", { cache: "no-store" });
  return r.ok ? (await r.json()).key || "" : "";
}
export async function pushSubscribe(payload: Record<string, unknown>): Promise<boolean> {
  const r = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return r.ok;
}
export async function getNations(): Promise<{ name: string; flag: string; pts: number; fans: number }[]> {
  const r = await fetch("/api/nations", { cache: "no-store" });
  return r.ok ? (await r.json()).nations || [] : [];
}
/** The Frozen Window — the active/last-settled round for a fixture (poll this ~2s). */
export async function roundsGet(fixture: number, squad: string | null): Promise<{ active: any; settled: any }> {
  const r = await fetch(`/api/rounds?fixture=${fixture}${squad ? `&squad=${squad}` : ""}`, { cache: "no-store" });
  return r.ok ? await r.json() : { active: null, settled: null };
}
export async function roundOpen(payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/rounds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", ...payload }) });
  return r.ok ? await r.json() : null;
}
export async function roundCall(payload: Record<string, unknown>): Promise<any> {
  const r = await fetch("/api/rounds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "call", ...payload }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export async function settleParlay(parlay: string): Promise<any> {
  const r = await fetch("/api/settle-parlay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parlay }) });
  return await r.json();
}
