"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserKernel } from "@/lib/kernelClient";
import { BrowserParlay } from "@/lib/parlayClient";
import { useAppWallet } from "@/lib/walletCtx";
import { GAMES } from "@/lib/features";
import { playPaid, hapticPaid, soundOn, setSoundOn } from "@/lib/sound";
import { detectLang, shareWin, shareStreak } from "@/lib/i18n";
import { canInstall, onInstallable, promptInstall, isIOS, isStandalone, setBadge } from "@/lib/install";
import MysteryMatch from "./MysteryMatch";
import RoundTable from "./RoundTable";
import { getMarkets, getParlays, getPositions, getScores, createMarket, compileMarket, squad as squadApi, squadGet, settleParlay, points as pointsApi, pointsGet, streakGrid as streakGridApi, streakGridText, getNations, getFixtures, getConfig, provisionHero, punditLine, hiloDeal, hiloGuess, roundsGet, roundOpen, roundCall, economyGet, economyDo, type Economy, livePulse, twistCall, type LivePulse, mysteryList, joinNationRoom } from "@/lib/api";
import { prettyErr } from "@/lib/errcopy";
import { Flag, FlagPair } from "@/components/TeamBits";
import { team } from "@/lib/teams";
import { enablePush, pushPermission } from "@/lib/pushClient";
import type { MarketView, ParlayView } from "@/lib/kernel";

// Fallback names shown instantly before /api/fixtures resolves; the live schedule fills the rest.
// Static seed; the full set is LEARNED at runtime from /api/fixtures (learnFixtures) so no market ever
// falls back to a "Home v Away" placeholder on a money card (audit #7 — the app's own labels must be true).
const FIXTURES: Record<string, { home: string; away: string }> = {
  "18172379": { home: "USA", away: "Bosnia & Herzegovina" },
  "18179551": { home: "Spain", away: "Austria" },
  "18179763": { home: "Portugal", away: "Croatia" },
  "18192996": { home: "Mexico", away: "England" },
  "18193785": { home: "USA", away: "Belgium" },
  "17588388": { home: "USA", away: "Australia" },
};
// Mutable runtime lookup, seeded from the statics and filled in as fixtures load. `fx()` is the single
// resolver everything uses; the "Home/Away" fallback is now only ever a momentary pre-load state.
const FIXTURE_NAMES: Record<string, { home: string; away: string }> = { ...FIXTURES };
function learnFixtures(list: any[]) { for (const f of list || []) { const id = String(f.fixtureId); const home = f.home || f.homeTeam, away = f.away || f.awayTeam; if (id && home && away) FIXTURE_NAMES[id] = { home, away }; } }
const fx = (fixtureId: string | number) => FIXTURE_NAMES[String(fixtureId)] || { home: "Home", away: "Away" };
/** Do we actually know who played? Audit #7: a money card may never say "Home v Away". Anything we
 * cannot name is a synthetic/dev pool and has no business on a surface where real money is shown. */
const fxKnown = (fixtureId: string | number) => !!FIXTURE_NAMES[String(fixtureId)];
const STATWORD = ["", "goal", "goal", "booking", "booking", "red card", "red card", "corner", "corner"];
// Canonical nations a fan can fly (names match the flag map in /api/nations so standings stay consistent).
// Names only — every surface renders the drawn flag-icons SVG via <Flag name={...}>, never an emoji.
const PICK_NATIONS = [
  { name: "USA" }, { name: "Brazil" }, { name: "Argentina" },
  { name: "France" }, { name: "England" }, { name: "Spain" },
  { name: "Mexico" }, { name: "Germany" }, { name: "Portugal" },
  { name: "Netherlands" }, { name: "Morocco" }, { name: "Japan" },
];

/** Fan-language question for a market — never "goals over 0". Base stat key (mod 1000) picks the
 * kind; the home/away side is the odd/even key; the threshold + comparison become plain English. */
function humanQ(who: string, base: number, comparison: number, threshold: number): string {
  const word = STATWORD[base] || "moment";
  if (comparison === 0) { // over T  →  strictly more than T (T=0 means "at least one")
    if (threshold <= 0) {
      if (word === "goal") return `${who} to score`;
      if (word === "corner") return `${who} to win a corner`;
      if (word === "booking") return `${who} to get booked`;
      if (word === "red card") return `${who} to get a red`;
    }
    return `${who}: ${threshold + 1}+ ${word}s`;
  }
  if (comparison === 1) return `${who} under ${threshold} ${word}s`;
  return `${who}: exactly ${threshold} ${word}s`;
}

function label(m: MarketView) {
  const f = fx(m.fixtureId);
  const base = m.statKey % 1000;
  const who = base % 2 === 1 ? f.home : f.away;
  return { match: `${f.home} v ${f.away}`, q: humanQ(who, base, m.comparison, m.threshold), f };
}
/** Test/nonsense pools (negative or absurd thresholds) never reach the consumer surfaces. */
/** A pool is "real" only if its predicate is sane AND we can name the match it belongs to. The second
 * half is what keeps synthetic dev pools (fixture 99999999) off every money surface. */
function realMarket(m: MarketView) { return m.threshold >= 0 && m.threshold <= 40 && fxKnown(m.fixtureId); }
/** One consistent money format everywhere — no bare 3-vs-2-decimal drift, no jargon unit. Money is shown
 * in "coins", the app's felt unit — never SOL/crypto terms (felt-not-shown). `money()` appends the unit
 * for standalone amounts; `fmtAmt()` stays bare for tight inline stats and side-by-side pot readouts. */
const COIN = "coins";
// Mute-money (responsible-play): a global switch that blanks every monetary figure while leaving the
// game layer — points, streaks, standings — fully visible. Read from a module var so the pure money
// formatters can honour it; toggling flips the var + persists it and re-renders the tree.
let MONEY_MUTED = false;
function setMoneyMuted(v: boolean) { MONEY_MUTED = v; if (typeof window !== "undefined") localStorage.setItem("gaffer_mute_money", v ? "1" : "0"); }
// Spoiler-safe: hide live scores/events for fans watching on a broadcast delay. The game still plays —
// pools, streaks and the Frozen Window all work — you just don't see the scoreline until you opt in.
let SPOILER_SAFE = false;
function setSpoilerSafe(v: boolean) { SPOILER_SAFE = v; if (typeof window !== "undefined") localStorage.setItem("gaffer_spoiler_safe", v ? "1" : "0"); }
const fmtAmt = (n: number) => (MONEY_MUTED ? "•••" : Number(n || 0).toFixed(2));
const money = (n: number) => (MONEY_MUTED ? "•••" : `${fmtAmt(n)} ${COIN}`);
const day = () => new Date().toISOString().slice(0, 10);
const EXPLORER = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const DEV = process.env.NEXT_PUBLIC_GAFFER_DEV === "1"; // dev/demo controls (spin-up pool, manual settle) — OPT-IN only; consumer builds never show them
// Repeating polls keep the app live; `?nopoll` disables them (one data load only) so screenshot tooling
// can reach document-idle. Real users never pass it.
const POLL = typeof window === "undefined" || new URLSearchParams(window.location.search).get("nopoll") == null;

// Parimutuel projection: if your side wins, payout = potAfter × yourStake / sideAfter.
/** Which side a market paid, or 0 if nobody did.
 *
 * 1 = SETTLED_YES, 3 = SETTLED_NO, 2 = VOID (both sides refunded). Status 3 is the ending that could not
 * exist before `settle_no`: the thing was proven not to have happened, and the fans who said so take the
 * pot. Anything that used to test `status === 1 && side === 1` was quietly assuming NO could never win. */
const wonSide = (m: MarketView): 0 | 1 | 2 => (m.status === 1 ? 1 : m.status === 3 ? 2 : 0);
/** Did the pool pay out at all (as opposed to refunding)? */
const isPaid = (m: MarketView) => wonSide(m) !== 0;

function projection(m: MarketView, side: number, stakeSol: number) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9;
  const sideNow = side === 1 ? yes : no;
  const potAfter = yes + no + stakeSol;
  const sideAfter = sideNow + stakeSol;
  const payout = sideAfter > 0 ? (potAfter * stakeSol) / sideAfter : stakeSol;
  return { yes, no, potNow: yes + no, payout, multiple: stakeSol > 0 ? payout / stakeSol : 0 };
}
/** What a position ALREADY IN the pool collects if its side wins.
 *
 * Not the same sum as `projection()`, and the difference is money. `projection()` answers "if I add this
 * stake, what would I win" — it adds the stake to both the pot and your side. A position you already hold
 * is *in* those totals, so running it through `projection()` counts your stake twice and quietly
 * understates the payout. This is the same arithmetic `claim()` performs against the chain.
 */
function heldPayout(m: MarketView, side: number, amountSol: number) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9;
  const pot = yes + no, sideTotal = side === 1 ? yes : no;
  return sideTotal > 0 ? (pot * amountSol) / sideTotal : amountSol;
}
// Marginal multiple a side pays right now (empty side → null = "be first").
function sideMultiple(m: MarketView, side: number) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9, pot = yes + no, sideNow = side === 1 ? yes : no;
  return sideNow > 0 ? pot / sideNow : null;
}

type Toast = { msg: string; kind: "ok" | "err" } | null;
type Tab = "today" | "squad" | "live" | "cash" | "you";

export default function GafferApp() {
  const { wallet, address, login, mode, fund: ctxFund, onramp } = useAppWallet();
  const kernel = useMemo(() => (wallet ? new BrowserKernel(wallet) : null), [wallet]);
  const [bal, setBal] = useState(0);
  const [tab, setTab] = useState<Tab>("today");
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ m: MarketView; side: number } | null>(null);
  const [staked, setStaked] = useState<{ side: number; amt: number } | null>(null); // brief in-sheet "you're riding X" confirmation
  const [detail, setDetail] = useState<MarketView | null>(null);
  const [stake, setStake] = useState(0.05);
  const [shot, setShot] = useState(""); // optional sealed "Called Shot" one-liner (S2), revealed only if the call lands
  const [reason, setReason] = useState(""); // S5 — the written reason, shown on the call so a copy is never blind
  const [ambient, setAmbient] = useState(false);
  // Q8 — the Mystery Match run (a finished fixture, replayed anonymously from the real tick stream).
  const [mystery, setMystery] = useState<number | null>(null); // L4 glanceable full-screen match view
  const [paid, setPaid] = useState<{ amount: number; q: string; sig?: string; when: string; calledAt?: number | null; staked?: number; mult?: number | null } | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [streak, setStreak] = useState(0);
  const [freePicked, setFreePicked] = useState(false);
  const [freezes, setFreezes] = useState(1);
  const [nation, setNation] = useState("USA");
  const [userName, setUserName] = useState("You");
  const [points, setPoints] = useState(0);
  const [squadCode, setSquadCode] = useState("");
  const [squadData, setSquadData] = useState<any>(null);
  const [pendingJoin, setPendingJoin] = useState("");
  const [slip, setSlip] = useState<{ market: MarketView; q: string; side: number }[]>([]);
  const [slipOpen, setSlipOpen] = useState(false);
  const [parlays, setParlays] = useState<ParlayView[]>([]);
  const [positions, setPositions] = useState<{ market: string; side: number; amount: number; claimed: boolean }[]>([]);
  const [frozen, setFrozen] = useState<{ active: any; settled: any }>({ active: null, settled: null });
  const [frozenSeen, setFrozenSeen] = useState<string>(""); // last settled round id the user dismissed
  const [muted, setMuted] = useState(false); // mirrors MONEY_MUTED for re-render; value itself unused
  const [onboarded, setOnboarded] = useState(true); // three-card intro; true until mount check so it never flashes
  const [spoiler, setSpoiler] = useState(false); // mirrors SPOILER_SAFE for re-render
  // 18+ confirmation lives in a ref, not state: the gate RE-RUNS the action that opened it, and a
  // state update wouldn't be visible to that already-captured closure — it would bounce off the gate
  // forever. The ref flips synchronously, so the retried call sails through.
  const ageOkRef = useRef(true);
  const [agePrompt, setAgePrompt] = useState<null | (() => void)>(null); // the action waiting behind the gate
  const [cfg, setCfg] = useState<{ rakeBps: number; maxRakeBps: number; onWinningsOnly: boolean }>({ rakeBps: 0, maxRakeBps: 500, onWinningsOnly: true });
  const [fixtures, setFixtures] = useState<any[]>([]);
  const [selectedFixture, setSelectedFixture] = useState<number>(18172379);
  const [pendingPool, setPendingPool] = useState<string | null>(null); // ?pool= deep link awaiting markets
  /** True once the match was chosen deliberately — by the fan, or by the link a mate sent them.
   *
   * The auto-select below picks a sensible default match on first load. It used to pick it whenever the
   * current fixture was still the initial constant, which is exactly what a `?pool=` link on that very
   * fixture leaves behind — so a shared call quietly landed the fan on a different match than the one
   * they were sent. A deliberate choice is now never overridden. */
  const fixtureChosen = useRef(false);
  const parlay = useMemo(() => (wallet ? new BrowserParlay(wallet) : null), [wallet]);
  const activeFixture = selectedFixture;

  const userId = address;
  const flash = (msg: string, kind: "ok" | "err" = "ok") => { setToast({ msg, kind }); setTimeout(() => setToast(null), 3200); };

  /** The 18+ gate, asked at the money — not at the door.
   *
   * Every app in the category that wins on first-run defers its signup wall: you browse the board, tap a
   * side and build a slip before anyone asks you anything. A gate on the first frame is the single most
   * expensive thing you can put in front of a stranger, and we were charging it for a screen that costs
   * nothing to show. So: browsing, the free daily call, and building a slip are all open. The gate stands
   * exactly where the obligation begins — putting coins on a pool — and when it clears it RUNS the action
   * that opened it, so the tap is never spent on the gate itself.
   */
  const gateAge = (fn: () => void) => {
    if (ageOkRef.current) { fn(); return; }
    setAgePrompt(() => fn);
  };
  // Every PAID moment is kept as a receipt on the device — the wall of your greatest calls (You tab).
  const keepReceipt = (r: any) => {
    try {
      const all = JSON.parse(localStorage.getItem("gaffer_receipts") || "[]");
      all.unshift(r);
      localStorage.setItem("gaffer_receipts", JSON.stringify(all.slice(0, 24)));
    } catch { /* private mode */ }
  };

  const refresh = useCallback(async () => {
    try {
      const [mk, pl] = await Promise.all([getMarkets(), getParlays()]);
      // Markets carry their own fixture names (server-joined from the durable cache), so a pool on a
      // match that has dropped off the live slate still names itself instead of "Home v Away".
      learnFixtures(mk as any[]);
      setMarkets(mk); setParlays(pl);
      if (kernel) { setBal(await kernel.balanceSol()); setPositions(await getPositions(address)); }
    } catch {
      // Keep the last-known-good view rather than a stuck spinner; the next tick retries.
    } finally { setLoading(false); }
  }, [kernel, address]);

  useEffect(() => {
    const today = day();
    setFreePicked(localStorage.getItem("gaffer_freeday") === today);
    setNation(localStorage.getItem("gaffer_nation") || "USA");
    setUserName(localStorage.getItem("gaffer_name") || "You");
    setSquadCode(localStorage.getItem("gaffer_squad") || "");
    MONEY_MUTED = localStorage.getItem("gaffer_mute_money") === "1"; setMuted(MONEY_MUTED);
    SPOILER_SAFE = localStorage.getItem("gaffer_spoiler_safe") === "1"; setSpoiler(SPOILER_SAFE);
    ageOkRef.current = localStorage.getItem("gaffer_age_ok") === "1";
    setOnboarded(localStorage.getItem("gaffer_onboarded") === "1");
    getConfig().then(setCfg);
    const sp = new URLSearchParams(window.location.search).get("squad");
    if (sp) {
      const code = sp.toUpperCase(); const inSquad = localStorage.getItem("gaffer_squad");
      setPendingJoin(code);
      if (!inSquad) setTab("squad");
      else if (inSquad !== code) { setTab("squad"); flash(`Leave your squad first to join ${code}`, "err"); }
    }
    // ?pool= deep link (the booking-code loop): a shared call opens THAT exact pool, ready to back.
    const pl = new URLSearchParams(window.location.search).get("pool");
    if (pl) setPendingPool(pl);
  }, []);
  // Resolve the shared pool once markets arrive: open its detail sheet and select its match.
  useEffect(() => {
    if (!pendingPool || markets.length === 0) return;
    const m = markets.find((x) => x.pubkey === pendingPool);
    setPendingPool(null);
    if (m) { fixtureChosen.current = true; setSelectedFixture(Number(m.fixtureId)); setDetail(m); flash("Your mate sent you this call 👇"); }
  }, [pendingPool, markets]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); if (!POLL) return; const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);

  // Zero-friction onboarding: the first time a device lands (dev/instant-wallet mode), quietly hand it
  // play-coins from the faucet so a judge can make a real call within seconds — no login, no "add funds"
  // detour. Guarded so it fires once per device and never drains the faucet on every visit.
  useEffect(() => {
    if (!address || mode !== "dev") return;
    if (typeof window === "undefined" || localStorage.getItem("gaffer_autofunded") === "1") return;
    localStorage.setItem("gaffer_autofunded", "1");
    (async () => {
      try {
        const b = await (kernel?.balanceSol() ?? Promise.resolve(0));
        if (b >= 0.02) return; // already has coins (returning device) — nothing to do
        const r = await ctxFund();
        if (r && !r.error) { await refresh(); flash("We've spotted you some coins — go call something 🟢"); }
      } catch { /* faucet busy — the manual Add funds button still works */ }
    })();
  }, [address, mode, kernel, ctxFund, refresh]);

  // Real-fixture spine: pull today's actual schedule, feed every fixture's real names into the name map
  // so every surface (pools, Match Centre, Frozen Window) reads "Spain v Austria", not a hardcode.
  useEffect(() => {
    getFixtures().then((list) => {
      if (!list.length) return;
      learnFixtures(list);
      setFixtures(list);
      // Lead with the match that's actually ON — live now, then kicking-off-soon, then the next upcoming
      // fixture on the real schedule. A finished match is never the default (it used to default to whatever
      // had the seeded demo pool, which anchored a real user on a finished game instead of what's live).
      if (fixtureChosen.current) return;   // a shared link, or the fan's own tap, always wins
      const live = list.find((f: any) => f.state === "live");
      const soon = list.find((f: any) => f.state === "soon");
      const upcoming = [...list].filter((f: any) => f.state !== "finished").sort((a: any, b: any) => a.startTime - b.startTime)[0];
      const pick = live?.fixtureId ?? soon?.fixtureId ?? upcoming?.fixtureId ?? list[0]?.fixtureId;
      if (pick) setSelectedFixture(Number(pick));
    });
  }, [markets.length]);

  // Keep a fresh, open hero pool alive so every visitor can reach the PAID moment (the last one may have
  // just been collected → settled). Runs once on load; the server no-ops when an open pool already exists.
  useEffect(() => { provisionHero().then((r) => { if (r?.market) refresh(); }); }, [refresh]);

  // Never greet a fan with "no pools": when the match they picked (often the LIVE one) has none open,
  // stand up the standard home/away-to-score pair for it. Once per fixture per session; the server
  // validates the fixture against the real schedule and no-ops if pools already exist.
  const provisionAsked = useMemo(() => new Set<number>(), []);
  useEffect(() => {
    if (loading || !selectedFixture || provisionAsked.has(selectedFixture)) return;
    const hasOpen = markets.some((m) => Number(m.fixtureId) === selectedFixture && m.status === 0 && m.threshold >= 0 && m.threshold <= 40);
    if (hasOpen) return;
    provisionAsked.add(selectedFixture);
    provisionHero(selectedFixture).then((r) => { if (r?.created) refresh(); });
  }, [selectedFixture, markets, loading, provisionAsked, refresh]);

  // Points, streak and freezes are server-authoritative (KILL-2): read them from the ledger, never
  // trust or write a local total. Refreshes whenever the wallet (userId) resolves or after a grant.
  const refreshPoints = useCallback(async () => {
    if (!userId) return;
    // Neon can cold-start (~2s) and the first read may fail; retry so a real total NEVER shows as 0
    // just because the fetch was slow (a wrong number is worse than a spinner — the "numbers never lie" rule).
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await pointsGet(userId);
      if (r) { setPoints(r.points); setStreak(r.streak); setFreezes(r.freezes); if (r.token) localStorage.setItem("gaffer_ptoken", r.token); return; }
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
  }, [userId]);
  useEffect(() => { refreshPoints(); }, [refreshPoints]);

  // The economy (tier, league, quests, medals, wager, milestones, boosters, rollover) is derived
  // server-side from the same ledger — a quest tick or a tier can never be asserted by this client.
  const [econ, setEcon] = useState<Economy | null>(null);
  const refreshEcon = useCallback(async () => { setEcon(await economyGet(userId || undefined)); }, [userId]);
  useEffect(() => { refreshEcon(); }, [refreshEcon]);
  // A milestone is returned exactly once (the server banks it) — mint its share card the moment it lands.
  const [milestone, setMilestone] = useState<number | null>(null);
  useEffect(() => { if (econ?.milestoneReached) setMilestone(econ.milestoneReached); }, [econ?.milestoneReached]);
  // K6 — the quiet notification: how many wins are sitting there waiting to be collected.
  useEffect(() => {
    const collectable = positions.filter((p: any) => {
      const m = markets.find((x: MarketView) => x.pubkey === p.market);
      return m && !p.claimed && p.amount > 0 && ((isPaid(m) && p.side === wonSide(m)) || m.status === 2);
    }).length;
    setBadge(collectable);
  }, [positions, markets]);

  // T3 — the wager and the one-time Earn-Back repair. Both are point SPENDS, so both go through the
  // token-guarded economy route; the client never adjusts a total itself.
  const [econBusy, setEconBusy] = useState(false);
  const econAct = useCallback(async (action: "open_wager" | "earn_back" | "enter_knockouts" | "use_mystery", okMsg: string) => {
    if (!userId || econBusy) return;
    setEconBusy(true);
    try {
      const r = await economyDo(action, { userId, token: localStorage.getItem("gaffer_ptoken") || "" });
      if (r?.ok) { flash(okMsg, "ok"); await Promise.all([refreshEcon(), refreshPoints()]); }
      else flash(r?.reason || "That didn't go through — try again.", "err");
    } finally { setEconBusy(false); }
  }, [userId, econBusy, refreshEcon, refreshPoints]);
  const onWager = useCallback(() => econAct("open_wager", "Wager placed — keep the run alive."), [econAct]);
  const onEarnBack = useCallback(() => econAct("earn_back", "Run repaired. Pick up where you left off."), [econAct]);
  const onEnterKnockouts = useCallback(() => econAct("enter_knockouts", "You're in. Everyone starts level."), [econAct]);
  const onPlayMystery = useCallback(() => econAct("use_mystery", "Double Down armed — your next correct call pays twice."), [econAct]);
  // The per-user token guards every points grant (so no one can mint points for another id).
  const pTok = () => (typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "");

  // The squad fetch carries everything the room needs: members + feed, the commissioner's settings (Q9),
  // the auto-named lore wall (Q2), and this fan's Fade Duels with their standing H2H (S6).
  const [duels, setDuels] = useState<any[]>([]);
  const [squadSettings, setSquadSettings] = useState<any>(null);
  const [lore, setLore] = useState<any[]>([]);
  const refreshSquad = useCallback(async () => {
    if (!squadCode) return;
    const r = await squadGet(squadCode, userId);
    if (r?.squad) setSquadData(r.squad);
    if (r?.duels) setDuels(r.duels);
    if (r?.settings) setSquadSettings(r.settings);
    if (r?.lore) setLore(r.lore);
  }, [squadCode, userId]);

  /** Fade a mate: take the other side of their call and open a duel that they can see too. */
  const onFade = useCallback(async (f: any) => {
    const mySide = f.side === 1 ? 2 : 1;
    copyCall(f.market, mySide);            // the slip opens on the OPPOSITE side — you think they're wrong
    const r = await squadApi("duel", {
      code: squadCode, userId, token: sqTok(), name: userName, side: mySide,
      targetId: f.userId, targetName: f.name, targetSide: f.side, market: f.market, q: f.q,
    });
    if (r?.duels) { setDuels(r.duels); flash(`Fade duel with ${f.name} — you're on the other side`); }
    else flash(r?.error || `You're already duelling ${f.name} on this one`, "err");
  }, [squadCode, userId, userName]);

  /** Commissioner actions (Q9). The server re-checks ownership; this only shapes the UI. */
  const onCommish = useCallback(async (action: "kick" | "proxy" | "visibility" | "prize", payload: Record<string, unknown>) => {
    const r = await squadApi(action, { code: squadCode, userId, token: sqTok(), ...payload });
    if (r?.ok) { setSquadSettings(r.settings ?? squadSettings); await refreshSquad(); flash("Done."); }
    else flash(r?.error || "That didn't go through.", "err");
  }, [squadCode, userId, squadSettings, refreshSquad]);
  useEffect(() => {
    if (!squadCode) { setSquadData(null); return; }
    refreshSquad();
    if (!POLL) return;
    const t = setInterval(refreshSquad, 5000);
    return () => clearInterval(t);
  }, [squadCode, refreshSquad]);

  // THE FROZEN WINDOW — poll for a live round on the fixture. When one fires, every squad member's phone
  // flips to the same takeover at the same second; the reveal lingers until dismissed.
  useEffect(() => {
    let on = true;
    const tick = async () => { const r = await roundsGet(activeFixture, squadCode || null); if (on) setFrozen(r); };
    tick(); if (!POLL) return () => { on = false; }; const t = setInterval(tick, 2000);
    return () => { on = false; clearInterval(t); };
  }, [activeFixture, squadCode]);

  const frozenCall = async (roundId: string, side: string) => {
    const r = await roundCall({ roundId, userId, token: pTok(), name: userName, side });
    if (r?.body?.round) setFrozen((f) => ({ ...f, active: r.body.round }));
    else if (r?.status === 409) flash("Locked — a beat too late.", "err");
  };
  const [frozenArming, setFrozenArming] = useState(false);
  const frozenTrigger = async (kind: "freeze" | "blackout") => {
    if (frozenArming) return;
    setFrozenArming(true);
    flash(kind === "freeze" ? "The referee's at the screen…" : "The market's gone quiet…");
    try { const r = await roundOpen({ kind, fixtureId: activeFixture, squadCode: squadCode || null }); if (r?.round) { setFrozen({ active: r.round, settled: null }); refreshPoints(); } }
    finally { setFrozenArming(false); }
  };
  // A settled round the user hasn't dismissed and took part in (or a squad round) → show the reveal.
  const frozenReveal = frozen.settled && frozen.settled.id !== frozenSeen ? frozen.settled : null;
  // An active round the user hasn't dismissed (gating on frozenSeen so the exit X sticks even if
  // the rounds poll re-fetches the still-open round — audit #3, never trap the user).
  const frozenActive = frozen.active && frozen.active.id !== frozenSeen ? frozen.active : null;

  const freePick = async (side: "yes" | "no") => {
    if (freePicked) return;
    if (!userId) { if (mode === "privy") login(); return; }
    let tok = pTok();
    if (!tok) { const g = await pointsGet(userId); if (g?.token) { localStorage.setItem("gaffer_ptoken", g.token); tok = g.token; } }
    setFreePicked(true); localStorage.setItem("gaffer_freeday", day());
    // The server records the pick (side + fixture, for later grading), grants the entry points, and
    // returns the derived streak. The token proves this grant is for THIS user.
    const fxn = fx(selectedFixture);
    const r = await pointsApi("free_pick", { userId, token: tok, side, fixtureId: selectedFixture, quest: `Goal before half-time? ${fxn.home} v ${fxn.away}`, squadCode: squadCode || null });
    if (r) {
      setPoints(r.points); setStreak(r.streak); setFreezes(r.freezes);
      if (squadCode) refreshSquad();
      flash(`Locked: ${side.toUpperCase()} — ${r.streak}-day streak`);
    } else { setFreePicked(false); flash("Couldn't lock your pick", "err"); }
  };
  const fund = async () => {
    if (!ageOkRef.current) { gateAge(() => { void fund(); }); return; }
    if (!address) { if (mode === "privy") login(); return; }
    setBusy("fund");
    try {
      if (mode === "privy") { await onramp(); flash("Add funds"); } // production: Privy fiat on-ramp
      else { const r = await ctxFund(); if (r?.error) throw new Error(r.error); flash(r?.funded ? "Added funds" : "Already funded"); } // dev: faucet
      await refresh();
    } catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };
  const spinUp = async (fixtureId = selectedFixture) => {
    setBusy("spin");
    try { const r = await createMarket({ fixtureId, statKey: 1, period: 4, threshold: 0, comparison: 0 }); if (r.error) throw new Error(r.error); flash("Pool live"); await refresh(); }
    catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };

  /** Ask your own question.
   *
   * The server turns the sentence into a predicate, and refuses anything the chain couldn't prove or that
   * has already happened. The pool itself is minted by THIS wallet — the fan who wants the question pays
   * its rent, exactly as a slip does — so an open question costs us nothing to offer and can't be used to
   * drain anything. The age gate stands here because minting spends coins.
   */
  const askMarket = async (text: string): Promise<boolean> => {
    if (!ageOkRef.current) { gateAge(() => { void askMarket(text); }); return false; }
    if (!kernel) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return false; }
    setBusy("ask");
    try {
      const c = await compileMarket(text, selectedFixture);
      if (!c.ok) { flash(c.reason, "err"); return false; }
      // The server decides when the pool expires: the end of the match, so its NO side stays provable.
      await kernel.createMarket({ fixtureId: c.fixtureId, ...c.market }, c.expiryTs);
      flash(`Your pool is live — ${c.question}`);
      await refresh();
      return true;
    } catch (e: any) { flash(prettyErr(e), "err"); return false; }
    finally { setBusy(null); }
  };

  /** The net rippled.
   *
   * A goal is the only thing that happens in football, and it is the moment every other app makes you go
   * looking for. Here it announces itself: the chime, the buzz, the scoreline, and — because a goal is
   * also the instant a pool becomes settleable — an immediate re-read of the pools rather than waiting
   * out the next poll. Muted when the fan has asked for quiet (spoiler-safe watch-along mode). */
  const onGoal = useCallback((msg: string) => {
    if (SPOILER_SAFE) return;
    flash(msg);
    try { playPaid(); hapticPaid(); } catch { /* no audio/haptics on this device */ }
    void refresh();
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const doStake = async () => {
    if (!sheet) return;
    if (!ageOkRef.current) { gateAge(() => { void doStake(); }); return; }
    if (!kernel) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return; }
    setBusy("stake");
    try {
      // Stamp the crowd's belief in YOUR side at the instant you lock — your side's share of the pool.
      // Low = you called it against the room; it rides onto the receipt if it lands ("Called at 23%").
      const yy = Number(sheet.m.yesTotal), nn = Number(sheet.m.noTotal), pp = yy + nn;
      const share = pp > 0 ? Math.round((100 * (sheet.side === 1 ? yy : nn)) / pp) : 50;
      try { localStorage.setItem("gaffer_calledat_" + sheet.m.pubkey, String(share)); } catch { /* private mode */ }
      const sig = await kernel.join(sheet.m.pubkey, sheet.side, stake);
      // Points are granted server-side ONLY after verifying this exact tx on-chain, signed by the user.
      pointsApi("stake", { userId, token: pTok(), sig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      // S1/T1 — bank the stamp server-side, anchored to the odds message that existed at this instant.
      // localStorage above is only an offline echo; the receipt reads the server's copy.
      economyDo("stamp", { userId, token: pTok(), market: sheet.m.pubkey, side: sheet.side === 1 ? "yes" : "no", calledAt: share, fixtureId: Number(sheet.m.fixtureId) || 0 });
      if (squadCode) squadApi("call", { code: squadCode, userId, token: sqTok(), name: userName, market: sheet.m.pubkey, side: sheet.side, q: label(sheet.m).q, sealed: shot.trim() || undefined, reason: reason.trim() || undefined, lockTs: Number(sheet.m.lockTs) * 1000 || undefined }).then((r) => r?.squad && setSquadData(r.squad));
      setShot(""); setReason(""); // clear the sealed line + reason once they've ridden along with the call
      // In-context success: the sheet flips to "you're riding X" for a beat, then closes (audit #2 — never a silent close).
      setStaked({ side: sheet.side, amt: stake });
      setTimeout(() => { setStaked(null); setSheet(null); }, 1500);
      await refresh();
    }
    catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };
  const settle = async (m: MarketView) => {
    setBusy("settle:" + m.pubkey);
    try { const r = await fetch("/api/settle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: m.pubkey }) }).then((x) => x.json()); if (r.error) throw new Error(r.error); flash(r.settled ? "Settled on the proof" : "Not settleable: " + r.reason, r.settled ? "ok" : "err"); await refresh(); setDetail(null); }
    catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };
  const claim = async (m: MarketView) => {
    if (!kernel) return; setBusy("claim:" + m.pubkey);
    try {
      // Side-aware: figure out which of the user's positions are actually claimable for this market's
      // resolution. SETTLED_YES → only YES wins; SETTLED_NO → only NO wins; VOID → either side refunds.
      const [posYes, posNo] = await Promise.all([kernel.myPosition(m.pubkey, 1), kernel.myPosition(m.pubkey, 2)]);
      const win = wonSide(m);   // 0 = void, both refund
      const targets: number[] = [];
      if (win === 1) { if (posYes && !posYes.claimed) targets.push(1); }
      else if (win === 2) { if (posNo && !posNo.claimed) targets.push(2); }
      else if (m.status === 2) { if (posYes && !posYes.claimed) targets.push(1); if (posNo && !posNo.claimed) targets.push(2); }
      if (targets.length === 0) { flash(win ? "That side didn't win" : "Nothing to claim here", "err"); setBusy(null); return; }
      const pot = (Number(m.yesTotal) + Number(m.noTotal)) / 1e9;
      // The pot is split across the side that won — whichever it was.
      const winTotal = (win === 2 ? Number(m.noTotal) : Number(m.yesTotal)) / 1e9 || 1;
      let lastSig = "", total = 0;
      for (const side of targets) {
        const pos = side === 1 ? posYes : posNo;
        lastSig = await kernel.claim(m.pubkey, side);
        total += win ? pot * ((pos?.amount || 0) / winTotal) : (pos?.amount || 0);
      }
      if (win) {
        const staked = ((win === 2 ? posNo : posYes)?.amount || 0);
        const calledAt = Number(localStorage.getItem("gaffer_calledat_" + m.pubkey)) || null;
        const receipt = { amount: total, q: label(m).q, sig: lastSig, when: new Date().toLocaleString(), calledAt, staked, mult: staked > 0 ? total / staked : null, market: m.pubkey };
        keepReceipt(receipt);
        setPaid(receipt);
        // The server re-derives the payout from this very transaction; market/question/stake are only
        // context for the receipt and the public feed — the money numbers are never taken on trust.
        pointsApi("win", {
          userId, token: pTok(), sig: lastSig, squadCode: squadCode || null,
          name: userName, question: label(m).q, market: m.pubkey, stakeLamports: Math.round(staked * 1e9),
        }).then((r) => {
          if (r?.points != null) setPoints(r.points);
          // The server owns both of these: "settled Ns after full-time" (measured off the proof) and the
          // stamp (captured at the lock). localStorage is only a fallback for an offline first paint.
          setPaid((p: any) => (p ? {
            ...p,
            ...(r?.settledAfterMs != null ? { settledAfterMs: r.settledAfterMs } : {}),
            ...(r?.calledAt != null ? { calledAt: r.calledAt, mult: p.staked > 0 ? p.amount / p.staked : p.mult } : {}),
          } : p));
          refreshEcon();
        });
      } else { flash(`Refunded ${total.toFixed(3)}`); }
      setDetail(null); await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };
  // One-tap collect from the money tab: if the pool's still open but its match is over, crank the
  // permissionless settle on the real proof first, then pay the winner out — the whole climax in one press.
  const collect = async (m: MarketView) => {
    if (!kernel) { if (mode === "privy") login(); return; }
    if (m.status !== 0) return claim(m); // already settled → straight to payout
    setBusy("collect:" + m.pubkey);
    try {
      const r = await fetch("/api/settle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: m.pubkey }) }).then((x) => x.json());
      if (!r.settled) { flash(/proof|open/i.test(r.reason || "") ? "Still cooking — collect the moment it lands." : "Not ready yet — give it a moment.", "err"); setBusy(null); return; }
      const fresh = await getMarkets(); setMarkets(fresh);
      const mk = fresh.find((x) => x.pubkey === m.pubkey);
      setBusy(null);
      if (mk) await claim(mk); // fires the PAID overlay + win points on the freshly-settled pool
    } catch (e: any) { flash(prettyErr(e, "neutral"), "err"); setBusy(null); }
  };

  const member = (nm?: string) => ({ id: userId, name: nm || userName, nation });
  const setName = (nm: string) => { setUserName(nm); localStorage.setItem("gaffer_name", nm); };
  const sqTok = () => (typeof window !== "undefined" ? localStorage.getItem("gaffer_squad_token") || "" : "");
  const syncSquad = (patch: any) => { if (squadCode && userId) squadApi("sync", { code: squadCode, userId, token: sqTok(), patch }).then((r) => r?.squad && setSquadData(r.squad)); };
  const createMySquad = async (name: string, nm?: string) => { if (nm) setName(nm); const r = await squadApi("create", { name, member: member(nm) }); if (r?.squad) { setSquadCode(r.squad.code); localStorage.setItem("gaffer_squad", r.squad.code); if (r.token) localStorage.setItem("gaffer_squad_token", r.token); setSquadData(r.squad); flash("Squad created — share the code"); } };
  /** Q6 — no mates to invite? Land in your nation's public room, which already has people in it. */
  const joinTribe = async () => {
    const r = await joinNationRoom(nation, member());
    if (r?.squad) {
      setSquadCode(r.squad.code); localStorage.setItem("gaffer_squad", r.squad.code);
      if (r.token) localStorage.setItem("gaffer_squad_token", r.token);
      setSquadData(r.squad); flash(`You're in the ${nation} tribe`);
    } else flash("Couldn't open the room", "err");
  };
  const joinByCode = async (code: string, nm?: string) => { if (nm) setName(nm); const r = await squadApi("join", { code, member: member(nm) }); if (r?.squad) { setSquadCode(r.squad.code); localStorage.setItem("gaffer_squad", r.squad.code); if (r.token) localStorage.setItem("gaffer_squad_token", r.token); setSquadData(r.squad); setPendingJoin(""); flash("Joined " + r.squad.name); } else flash("Squad not found", "err"); };
  const postBanter = async (text: string) => { const r = await squadApi("post", { code: squadCode, userId, name: userName, text, token: sqTok() }); if (r?.squad) setSquadData(r.squad); };
  const reactTo = async (msgId: string, emoji: string) => { const r = await squadApi("react", { code: squadCode, msgId, emoji, userId, token: sqTok() }); if (r?.squad) setSquadData(r.squad); };
  const copyCall = (marketStr: string, side: number) => { const m = markets.find((x) => x.pubkey === marketStr); if (m && m.status === 0) setSheet({ m, side }); else flash("That pool has closed", "err"); };
  const leaveSquad = () => { setSquadCode(""); setSquadData(null); localStorage.removeItem("gaffer_squad"); localStorage.removeItem("gaffer_squad_token"); flash("Left the squad"); };

  // ── Multi-call slip (parlay): all calls must land (Power). One match per slip in v1. ──
  const addToSlip = (m: MarketView, side: number = 1) => {
    if (m.status !== 0) { flash("That pool has closed", "err"); return; }
    if (slip.find((s) => s.market.pubkey === m.pubkey)) { flash("Already in your slip"); return; }
    if (slip.length > 0 && slip[0].market.fixtureId !== m.fixtureId) { flash("One match per slip for now", "err"); return; }
    if (slip.length >= 8) { flash("Max 8 calls in a slip", "err"); return; }
    setSlip([...slip, { market: m, q: label(m).q, side }]); flash("Added to your slip");
  };
  const removeFromSlip = (pubkey: string) => setSlip(slip.filter((s) => s.market.pubkey !== pubkey));
  /** S3 — edit a leg before the lock: flip which side of that call you're actually on. */
  const flipLeg = (pubkey: string) => setSlip(slip.map((s) => (s.market.pubkey === pubkey ? { ...s, side: s.side === 1 ? 2 : 1 } : s)));
  /** S3 — place the slip as POWER (one parlay, all must land) or FLEX (each call stands on its own).
   *
   * Flex needs no kernel change: it is the stake split across the same pools you already picked, each
   * settling and paying independently. Power is the parlay — one miss and the slip is off, and the whole
   * pot goes to the people who called every leg. Two genuinely different bets, one slip. */
  const placeSlip = async (stakeSol: number, shape: "power" | "flex" = "power") => {
    if (slip.length < 2) { flash("Add at least 2 calls to a slip", "err"); return; }
    if (!ageOkRef.current) { gateAge(() => { void placeSlip(stakeSol, shape); }); return; }
    const need = shape === "flex" ? kernel : parlay;
    if (!need) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return; }
    setBusy("slip");
    try {
      if (shape === "flex") {
        const each = Math.max(0.001, Math.round((stakeSol / slip.length) * 1000) / 1000);
        let last = "";
        for (const s of slip) {
          const side = s.side ?? 1;
          last = await kernel!.join(s.market.pubkey, side, each);
          economyDo("stamp", { userId, token: pTok(), market: s.market.pubkey, side: side === 1 ? "yes" : "no", calledAt: 50, fixtureId: Number(s.market.fixtureId) || 0 });
        }
        if (last) pointsApi("stake", { userId, token: pTok(), sig: last, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
        flash(`Flex placed — ${slip.length} calls, each pays on its own`);
      } else {
        const fixtureId = Number(slip[0].market.fixtureId);
        const legs = slip.map((s) => ({ statKey: s.market.statKey, period: s.market.period, threshold: s.market.threshold, comparison: s.market.comparison }));
        const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
        const pk = await parlay!.create(fixtureId, legs, expiry); // user-signed + rent-funded (not the server keypair)
        const joinSig = await parlay!.join(pk, 1, stakeSol); // back YES = every call lands
        pointsApi("stake", { userId, token: pTok(), sig: joinSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
        flash(`Slip placed — ${slip.length} calls, all must land`);
      }
      setSlip([]); setSlipOpen(false); await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };
  const fadeParlayFn = async (p: ParlayView) => {
    if (!ageOkRef.current) { gateAge(() => { void fadeParlayFn(p); }); return; }
    if (!parlay) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return; }
    setBusy("pfade:" + p.pubkey);
    try {
      const fadeSig = await parlay.join(p.pubkey, 2, 0.05); // back NO = the slip busts; funds the YES upside
      pointsApi("stake", { userId, token: pTok(), sig: fadeSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      flash("Faded — you win if the slip busts"); await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };
  const settleParlayFn = async (p: ParlayView) => {
    setBusy("psettle:" + p.pubkey);
    try { const r = await settleParlay(p.pubkey); if (r.error) throw new Error(r.error); flash(r.settled ? `Slip ${r.outcome === "NO" ? "busted" : "landed"}` : "Not ready: " + r.reason, r.settled ? "ok" : "err"); await refresh(); }
    catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };
  const claimParlayFn = async (p: ParlayView) => {
    if (!parlay) return; setBusy("pclaim:" + p.pubkey);
    try {
      const winSide = p.status === 1 ? 1 : p.status === 3 ? 2 : 0;
      const sides = p.status === 2 ? [1, 2] : winSide ? [winSide] : [];
      const pot = p.potSol;
      const winTotal = ((winSide === 1 ? Number(p.yesTotal) : Number(p.noTotal)) / 1e9) || 1;
      let total = 0, lastSig = "";
      for (const side of sides) {
        const pos = await parlay.myPosition(p.pubkey, side);
        if (!pos || pos.claimed) continue;
        lastSig = await parlay.claim(p.pubkey, side);
        total += p.status === 2 ? pos.amount : pot * (pos.amount / winTotal);
      }
      if (!lastSig) { flash(p.status === 1 || p.status === 3 ? "You weren't on the winning slip" : "Nothing to claim", "err"); setBusy(null); return; }
      if (p.status === 1 || p.status === 3) {
        const receipt = { amount: total, q: `${p.legs.length}-call slip`, sig: lastSig, when: new Date().toLocaleString() };
        keepReceipt(receipt);
        setPaid(receipt);
        pointsApi("win", { userId, token: pTok(), sig: lastSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      } else flash(`Refunded ${total.toFixed(3)}`);
      await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };

  const toggleMute = () => { const v = !MONEY_MUTED; setMoneyMuted(v); setMuted(v); };
  const toggleSpoiler = () => { const v = !SPOILER_SAFE; setSpoilerSafe(v); setSpoiler(v); };
  const confirmAge = () => {
    localStorage.setItem("gaffer_age_ok", "1");
    ageOkRef.current = true;
    const run = agePrompt; setAgePrompt(null);
    run?.();   // the gate never costs you the tap that opened it
  };
  void muted; void spoiler; // referenced only to re-render gated surfaces when a switch flips
  const shared = { markets, label, busy, setSheet, settle, claim, collect, setDetail, cfg };

  return (
    <div className="app-shell mx-auto max-w-[440px] flex flex-col" style={{ minHeight: "100dvh" }}>
      <header className="px-5 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <div><div className="text-[19px] font-extrabold tracking-tight leading-none">gaffer.</div><div className="mono text-[9px] tracking-widest uppercase text-[var(--muted)] mt-0.5">The Tournament</div></div>
        </div>
        <button onClick={() => setTab("you")} className="flex items-center gap-2 bg-[var(--ink)] text-white rounded-full pl-2 pr-3 py-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--greenb)] gf-pulse" /><span className="text-[15px] font-bold">{streak}</span>
          <span className="mono text-[8px] leading-tight text-[#9CA3AF]">DAY<br />STREAK</span>
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-5 pb-28">
        {tab === "today" && <Today {...shared} econ={econ} onEnterKnockouts={onEnterKnockouts} onPlayMystery={onPlayMystery} econBusy={econBusy} userName={userName} onRelive={(id: number) => setMystery(id)} onAmbient={() => setAmbient(true)} loading={loading} spinUp={spinUp} askMarket={askMarket} onGoal={onGoal} streak={streak} freezes={freezes} freePicked={freePicked} freePick={freePick} addToSlip={addToSlip} parlays={parlays} positions={positions} settleParlayFn={settleParlayFn} claimParlayFn={claimParlayFn} fadeParlayFn={fadeParlayFn} fixtures={fixtures} selectedFixture={selectedFixture} onSelectFixture={(f: number) => { fixtureChosen.current = true; setSelectedFixture(f); }} userId={userId} onHiloPoints={(p: number) => setPoints(p)} onGo={setTab} />}
        {tab === "squad" && <Squad userId={userId} userName={userName} setName={setName} nation={nation} setNation={(n: string) => { setNation(n); localStorage.setItem("gaffer_nation", n); syncSquad({ nation: n }); }} squadCode={squadCode} squadData={squadData} createMySquad={createMySquad} joinByCode={joinByCode} postBanter={postBanter} reactTo={reactTo} copyCall={copyCall} leaveSquad={leaveSquad} pendingJoin={pendingJoin} flash={flash} duels={duels} squadSettings={squadSettings} lore={lore} onFade={onFade} onCommish={onCommish} joinTribe={joinTribe} />}
        {tab === "live" && <Live fixtureId={activeFixture} onFreeze={() => frozenTrigger("freeze")} onBlackout={() => frozenTrigger("blackout")} userId={userId} squadCode={squadCode} userName={userName} positions={positions} markets={markets} flash={flash} />}
        {tab === "cash" && <Cash bal={bal} fund={fund} positions={positions} econ={econ} {...shared} />}
        {tab === "you" && <You streak={streak} bal={bal} points={points} nation={nation} userName={userName} userId={userId} flash={flash} cfg={cfg} muted={MONEY_MUTED} toggleMute={toggleMute} spoiler={SPOILER_SAFE} toggleSpoiler={toggleSpoiler} econ={econ} onWager={onWager} onEarnBack={onEarnBack} econBusy={econBusy} />}
      </main>

      {/* The sweat, ambient: your open calls tracked in one thin line, on every tab (bet365's in-play
          console reduced to a whisper). Tap → Cash, where the Collect lives. */}
      {(() => {
        const live = positions
          .filter((p) => !p.claimed && p.amount > 0)
          .map((p) => ({ p, m: markets.find((x) => x.pubkey === p.market) }))
          .filter((x): x is { p: any; m: MarketView } => !!x.m && (x.m.status === 0 || (isPaid(x.m) && x.p.side === wonSide(x.m))));
        if (live.length === 0 || tab === "cash") return null;
        const first = live.find((x) => isPaid(x.m)) || live[0];
        const won = isPaid(first.m);
        return (
          <button onClick={() => setTab("cash")} className={`gf-ticker fixed bottom-[72px] left-1/2 -translate-x-1/2 z-20 w-full max-w-[440px] px-5`}>
            <span className={`flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold shadow-lg border ${won ? "bg-[var(--green)] text-white border-[var(--green)]" : "bg-[var(--ink)] text-white border-[var(--ink)]"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${won ? "bg-white" : "bg-[var(--greenb)]"} gf-pulse shrink-0`} />
              <span className="truncate">{won ? `It landed — collect ${label(first.m).q}` : `Your call: ${label(first.m).q} · riding`}</span>
              {live.length > 1 && <span className="mono text-[10px] opacity-70 shrink-0">+{live.length - 1}</span>}
              <span className="ml-auto shrink-0">{won ? "→" : ""}</span>
            </span>
          </button>
        );
      })()}

      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[440px] bg-white/90 backdrop-blur border-t border-[var(--line)] px-4 pt-2 pb-5 flex justify-around">
        {([["today", "Today"], ["squad", "Squad"], ["live", "Live"], ["cash", "Cash"], ["you", "You"]] as const).map(([k, t]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            aria-label={t}
            aria-current={tab === k ? "page" : undefined}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-lg active:scale-95 transition-transform ${tab === k ? "text-[var(--ink)]" : "text-[#9CA3AF]"}`}>
            <TabIcon kind={k} active={tab === k} />
            <span className="mono text-[9px] tracking-wide font-semibold">{t}</span>
          </button>
        ))}
      </nav>

      {sheet && <CallSheet sheet={sheet} setSheet={setSheet} stake={stake} setStake={setStake} doStake={doStake} busy={busy} done={staked} shot={shot} setShot={setShot} reason={reason} setReason={setReason} canSeal={!!squadCode} />}
      {detail && <PoolDetail m={detail} close={() => setDetail(null)} setSheet={setSheet} settle={settle} claim={claim} busy={busy} kernel={kernel} cfg={cfg} flash={flash} />}
      {(frozenActive || frozenReveal) && (
        <FrozenWindow
          round={frozenActive || frozenReveal}
          userId={userId}
          onCall={frozenCall}
          onDismiss={() => { const id = (frozenActive || frozenReveal)?.id; if (id) setFrozenSeen(id); refreshPoints(); if (squadCode) refreshSquad(); }}
          onPinLore={(text: string) => { if (squadCode) postBanter(`📌 ${text}`); }}
        />
      )}
      {ambient && <AmbientView fixtureId={selectedFixture} positions={positions} onClose={() => setAmbient(false)} />}
      {mystery != null && (
        <MysteryMatch
          fixtureId={mystery}
          userId={userId}
          token={typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : ""}
          onClose={() => { setMystery(null); refreshPoints(); refreshEcon(); }}
          onPoints={() => { refreshPoints(); refreshEcon(); }}
        />
      )}
      {paid && <PaidOverlay paid={paid} close={() => setPaid(null)} flash={flash} econ={econ} />}
      {milestone != null && (
        <MilestoneCard
          days={milestone}
          onClose={() => setMilestone(null)}
          onShare={async () => {
            const g = await streakGridApi(userId);
            const text = g ? streakGridText(g.cells, g.streak, g.alivePct) : `${milestone}-day run on GAFFER.`;
            try {
              if ((navigator as any).share) await (navigator as any).share({ text });
              else { await navigator.clipboard.writeText(text); flash("Milestone copied"); }
            } catch { /* dismissed */ }
            setMilestone(null);
          }}
        />
      )}
      {DEV && !paid && <button onClick={() => setPaid({ amount: 61.4, q: "Egypt to score before half-time?", when: new Date().toLocaleString(), calledAt: 23, staked: 5, mult: 12.28, sig: "" })} className="fixed bottom-40 right-3 z-30 px-3 py-2 rounded-lg bg-[var(--ink)] text-white mono text-[10px] opacity-60">▸ preview PAID</button>}
      {slip.length > 0 && !slipOpen && <button onClick={() => setSlipOpen(true)} className="fixed bottom-[120px] left-1/2 -translate-x-1/2 z-30 px-5 py-3 rounded-full bg-[var(--green)] text-white font-bold shadow-lg">Slip · {slip.length} call{slip.length === 1 ? "" : "s"} →</button>}
      {slipOpen && (
        <SlipSheet
          slip={slip} removeFromSlip={removeFromSlip} flipLeg={flipLeg} placeSlip={placeSlip}
          close={() => setSlipOpen(false)} busy={busy} label={label}
          /* Everything still open on this slip's match that isn't already a leg — so a one-call slip can
             be completed without closing the sheet to go hunting for the second call. */
          candidates={markets.filter((m) =>
            m.status === 0 && Number(m.lockTs) > Math.floor(Date.now() / 1000) && realMarket(m) &&
            (slip.length === 0 || m.fixtureId === slip[0].market.fixtureId) &&
            !slip.some((s) => s.market.pubkey === m.pubkey))}
          addToSlip={addToSlip}
          backSingle={(m: MarketView, side: number) => { setSlipOpen(false); setSheet({ m, side }); }}
        />
      )}
      {/* Toast always sits highest in the bottom stack (nav 0–72 · call ticker 72 · slip 120 · toast 176), so it never overlaps a pill or a button. */}
      {toast && <div className={`fixed bottom-[176px] left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg ${toast.kind === "ok" ? "bg-[var(--ink)]" : "bg-red-600"}`}>{toast.msg}</div>}
      {!onboarded && (
        <Onboarding
          onDone={() => { localStorage.setItem("gaffer_onboarded", "1"); setOnboarded(true); }}
          onFreePick={(side) => freePick(side)}
          freePicked={freePicked}
          matchLabel={FIXTURE_NAMES[String(selectedFixture)] ? `${fx(selectedFixture).home} v ${fx(selectedFixture).away}` : "The match is on"}
          nation={nation}
          /* If they arrived on an invite, show the squad already calling it before any ask. */
          mates={(squadData?.feed || [])
            .filter((f: any) => f.kind === "call" && f.side)
            .slice(-3)
            .map((f: any) => ({ name: f.name, side: f.side }))}
          onSaveName={(n) => { setName(n); localStorage.setItem("gaffer_name", n); syncSquad({ name: n }); }}
          onAskPush={async () => {
            try {
              const tok = localStorage.getItem("gaffer_ptoken") || "";
              if (!userId || !tok) return false;
              return await enablePush(userId, tok, squadCode || null);
            } catch { return false; }
          }}
          onShare={async () => {
            const text = "I'm calling the World Cup on GAFFER — paid the second it happens. 🟢 gaffer-cyan.vercel.app";
            try { if ((navigator as any).share) await (navigator as any).share({ text }); else await navigator.clipboard.writeText(text); } catch { /* dismissed */ }
          }}
        />
      )}
      {agePrompt && <AgeGate onConfirm={confirmAge} onCancel={() => setAgePrompt(null)} />}
    </div>
  );
}

// 18+ gate — asked the first time you back a call with coins, never on arrival. Look, browse, take the
// free call, build a slip: all open. The moment you put something on a pool, we ask once, and remember.
function AgeGate({ onConfirm, onCancel }: any) {
  return (
    <div className="fixed inset-0 z-[60] bg-[var(--ink)] text-white flex flex-col items-center justify-center px-8 text-center">
      <Logo />
      <div className="text-2xl font-extrabold tracking-tight mt-5">One thing before you back it</div>
      <p className="text-[15px] text-white/80 mt-3 leading-relaxed max-w-xs">GAFFER is 18+. Today it runs on <b className="text-white">free play-coins with no cash value</b> — you never buy in. Confirm you&apos;re <b className="text-white">18 or older</b> and your call goes on.</p>
      <button onClick={onConfirm} className="mt-7 w-full max-w-xs h-14 rounded-2xl bg-white text-[var(--ink)] text-lg font-bold">I&apos;m 18+ — put my call on</button>
      <button onClick={onCancel} className="mt-3 text-[13px] text-white/50 underline underline-offset-4">Not yet — keep looking around</button>
      <p className="mono text-[10px] text-white/40 mt-5 max-w-xs leading-relaxed">Play for fun. If real-money play launches, it will be 18+ only and only where legal. You can hide all amounts anytime from the You tab.</p>
    </div>
  );
}

// The real-fixture schedule rail — today's actual matches, pick which one you're playing.
function MatchBar({ fixtures, selected, onSelect }: any) {
  if (!fixtures.length) return null;
  const abbr = (s: string) => (s || "").length > 11 ? s.slice(0, 10) + "…" : s;
  const time = (f: any) => {
    if (f.state === "live") return "LIVE";
    if (f.state === "finished") return "FT";
    const d = new Date(f.startTime); const h = (d.getTime() - Date.now()) / 3600_000;
    return h < 24 ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { weekday: "short" });
  };
  const order = { live: 0, soon: 1, upcoming: 2, finished: 3 } as any;
  const list = [...fixtures].sort((a, b) => (order[a.state] - order[b.state]) || (a.startTime - b.startTime)).slice(0, 12);
  return (
    <div className="-mx-5 px-5 mb-3 flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
      {list.map((f: any) => {
        const on = f.fixtureId === selected;
        return (
          <button key={f.fixtureId} onClick={() => onSelect(f.fixtureId)} className={`shrink-0 rounded-xl px-3 py-2 text-left border ${on ? "bg-[var(--ink)] text-white border-[var(--ink)]" : "bg-white border-[var(--line)]"}`}>
            <div className="flex items-center gap-1.5">
              {f.state === "live" && <span className="w-1.5 h-1.5 rounded-full bg-[var(--greenb)] gf-pulse" />}
              <span className={`mono text-[9px] tracking-wide ${f.state === "live" ? "text-[var(--greenb)]" : on ? "text-[#9CA3AF]" : "text-[var(--muted)]"}`}>{time(f)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[12px] font-bold leading-tight mt-1 whitespace-nowrap">
              <Flag name={f.home} size={13} round />{abbr(f.home)} <span className="opacity-40">v</span> <Flag name={f.away} size={13} round />{abbr(f.away)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// HI-LO — the rapid-fire stat game over real match history (the track's third idea, GAFFER-flavoured).
// Correct answers earn +5 points server-side; the local run counter is just the arcade feel.
function HiLo({ userId, onPoints }: { userId: string; onPoints: (p: number) => void }) {
  const [q, setQ] = useState<any>(null);
  const [reveal, setReveal] = useState<any>(null);
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState(false);
  const deal = useCallback(() => { setReveal(null); hiloDeal().then(setQ); }, []);
  useEffect(() => { deal(); }, [deal]);
  if (!q) return null;
  const guess = async (g: "MORE" | "LESS") => {
    if (busy || reveal) return;
    setBusy(true);
    const token = typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "";
    const r = await hiloGuess({ qid: q.qid, guess: g, userId, token });
    setBusy(false);
    if (!r) return;
    setReveal(r);
    setRun((s) => (r.correct ? s + 1 : 0));
    if (r.points != null) onPoints(r.points);
  };
  return (
    <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0e0e0f,#10261d)" }}>
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Hi-Lo · quick one</span>
        {run > 0 && <span className="mono text-[11px] font-bold text-[var(--greenb)]">run: {run}</span>}
      </div>
      <div className="flex items-center gap-1.5 mt-2.5 mono text-[10px] uppercase tracking-wide text-white/50"><FlagPair home={q.home} away={q.away} size={13} />{q.home} v {q.away}</div>
      <div className="text-[17px] font-bold mt-1 leading-snug">{q.stat} — more or less than <span className="text-[var(--greenb)]">{q.threshold}</span>?</div>
      {!reveal ? (
        <div className="flex gap-2 mt-3">
          <button disabled={busy} onClick={() => guess("MORE")} className="flex-1 h-11 rounded-xl bg-white text-[var(--ink)] font-extrabold disabled:opacity-60">MORE</button>
          <button disabled={busy} onClick={() => guess("LESS")} className="flex-1 h-11 rounded-xl bg-white/10 border border-white/25 font-extrabold disabled:opacity-60">LESS</button>
        </div>
      ) : (
        <div className="mt-3">
          <div className={`text-[15px] font-bold ${reveal.correct ? "text-[var(--greenb)]" : "text-red-400"}`}>
            {reveal.correct ? `Called it — it was ${reveal.actual}. +5 points` : `It was ${reveal.actual}. Run over.`}
          </div>
          <button onClick={deal} className="mt-2.5 w-full h-10 rounded-xl bg-white/10 border border-white/25 text-sm font-bold">Next one →</button>
        </div>
      )}
      <div className="mono text-[9px] text-white/35 mt-3">real final stats · replayable across every match</div>
    </div>
  );
}

// ── Drawn brand assets (never emoji-as-UI: emoji renders per-platform and reads as a hackathon tell;
// these are owned tiles/badges/marks in the ink·green·frost palette). Emoji stays only in banter. ──

/** A run/streak tile: green win, frost-blue freeze, outlined miss. The unit of the shareable grid. */
function RunTile({ kind, size = 18, onDark = false }: { kind: "hit" | "freeze" | "miss"; size?: number; onDark?: boolean }) {
  const s = { width: size, height: size };
  const cls = "inline-block rounded-[4px] align-middle shrink-0";
  if (kind === "hit") return <span className={cls} style={{ ...s, background: "linear-gradient(155deg,#34D399,#059669)" }} aria-label="win" />;
  if (kind === "freeze") return <span className={cls} style={{ ...s, background: "linear-gradient(155deg,#93C5FD,#3B82F6)" }} aria-label="freeze" />;
  return <span className={cls} style={{ ...s, border: `1.5px solid ${onDark ? "rgba(255,255,255,.22)" : "#D9DCE1"}` }} aria-label="—" />;
}

/** Leaderboard rank: gold/silver/bronze gradient chips for the top 3, a plain number after. */
function RankBadge({ i, onDark = false }: { i: number; onDark?: boolean }) {
  const tiers = [
    { bg: "linear-gradient(150deg,#FDE68A,#D4A017)", fg: "#5C4400" },
    { bg: "linear-gradient(150deg,#F1F5F9,#B4BEC9)", fg: "#3B4453" },
    { bg: "linear-gradient(150deg,#F0C89B,#B45309)", fg: "#3F2200" },
  ];
  if (i < 3) return <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-extrabold tabular-nums" style={{ background: tiers[i].bg, color: tiers[i].fg }}>{i + 1}</span>;
  return <span className={`inline-flex items-center justify-center w-5 text-[11px] font-bold tabular-nums ${onDark ? "text-white/60" : "text-[var(--muted)]"}`}>{i + 1}</span>;
}

/** Onboarding marks — inline SVG in brand colors, never emoji. */
function OnbMark({ kind }: { kind: "call" | "paid" | "freeze" }) {
  const g = "#34D399";
  if (kind === "call") return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="24" stroke={g} strokeWidth="3" /><circle cx="32" cy="32" r="13" stroke={g} strokeWidth="3" opacity=".6" /><circle cx="32" cy="32" r="4" fill={g} /></svg>
  );
  if (kind === "paid") return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none"><path d="M36 6 16 36h14l-4 22 22-32H34z" fill={g} /></svg>
  );
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none"><rect x="18" y="18" width="28" height="28" rx="7" transform="rotate(45 32 32)" fill="#3B82F6" /><rect x="25" y="25" width="14" height="14" rx="4" transform="rotate(45 32 32)" fill="#93C5FD" opacity=".7" /></svg>
  );
}

// The 8-second read: three cards, once ever, skippable — a first-timer knows the whole game before
// their first tap (Probo's radical-legibility lesson).
/** Y5 — the first sixty seconds.
 *
 * Deferred signup is worth +20% DAU, and 78% of people won't install an app for a one-off. So the order
 * is fixed and the ask comes last: land INSIDE the live match, see people you know already calling it,
 * lock a free call, and only then get asked who you are — framed as saving the call you just made, with
 * a way out. The un-voidable sentence lands after the value, not before it, because it is a promise about
 * something you now have. The push ask comes after that, softly, and never as a wall.
 *
 * Every step here is skippable. A wall in the first minute is the most expensive thing an app can build.
 */
/** The onboarding chrome, hoisted out of `Onboarding`.
 *
 * Declaring a component inside another component gives React a brand-new component *type* on every
 * render, so the whole subtree unmounts and remounts each time: state is lost, transitions restart, and
 * a button can vanish from under a tap. Playwright kept reporting "element was detached from the DOM"
 * on the skip button, which is exactly what that looks like from the outside — and what a fan's thumb
 * would hit on a slow phone.
 */
function OnboardShell({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[55] bg-[var(--ink)] text-white flex flex-col items-center justify-center px-8 text-center">{children}</div>;
}
function OnboardNext({ label, onClick, onSkip }: { label: string; onClick: () => void; onSkip: () => void }) {
  return (
    <>
      <button className="mt-8 w-full max-w-xs py-3.5 rounded-2xl bg-white text-[var(--ink)] text-lg font-bold" onClick={onClick}>{label}</button>
      <button className="mt-3 mono text-[11px] text-white/40" onClick={onSkip}>skip</button>
    </>
  );
}

function Onboarding({ onDone, onFreePick, freePicked, matchLabel, mates, nation, onSaveName, onAskPush, onShare }: {
  onDone: () => void;
  onFreePick?: (side: "yes" | "no") => void;
  freePicked?: boolean;
  matchLabel?: string;
  mates?: { name: string; side: number }[];
  nation?: string;
  onSaveName?: (n: string) => void;
  onAskPush?: () => Promise<boolean> | void;
  onShare?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const invited = (mates?.length ?? 0) > 0;

  // 0–10s: you are already in the match, and your mates are already in it.
  if (step === 0) return (
    <OnboardShell>
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{invited ? "Your squad is in" : "On right now"}</div>
      <div className="text-3xl font-extrabold tracking-tight mt-2">{matchLabel || "The match is on."}</div>
      {invited ? (
        <div className="mt-5 w-full max-w-xs space-y-1.5">
          {mates!.slice(0, 3).map((m, i) => (
            <div key={i} className="flex items-center gap-2 bg-white/10 rounded-xl px-3 py-2">
              <span className={`mono text-[9px] font-extrabold tracking-widest rounded px-1.5 py-0.5 ${m.side === 1 ? "bg-[var(--greenb)] text-[var(--ink)]" : "bg-white/20 text-white"}`}>{m.side === 1 ? "YES" : "NO"}</span>
              <span className="text-sm font-semibold flex-1 text-left truncate">{m.name} has called it</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[16px] text-white/75 mt-3 leading-relaxed max-w-xs">Call what happens next. Everyone who&apos;s right splits the pot. No bookie, no house.</p>
      )}
      <OnboardNext label="What&apos;s your call?" onClick={() => setStep(1)} onSkip={onDone} />
    </OnboardShell>
  );

  // 10–25s: the free call, before any identity ask at all.
  if (step === 1) return (
    <OnboardShell>
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Free · no sign-up</div>
      <div className="text-3xl font-extrabold tracking-tight mt-2">Goal before half-time?</div>
      <p className="text-[14px] text-white/60 mt-2">{matchLabel}</p>
      <div className="mt-6 w-full max-w-xs flex gap-2">
        <button onClick={() => { onFreePick?.("yes"); setStep(2); }} className="flex-1 py-4 rounded-2xl bg-[var(--greenb)] text-[var(--ink)] text-lg font-bold">Yes</button>
        <button onClick={() => { onFreePick?.("no"); setStep(2); }} className="flex-1 py-4 rounded-2xl bg-white/15 text-white text-lg font-bold">No</button>
      </div>
      <button className="mt-6 mono text-[11px] text-white/40" onClick={onDone}>skip</button>
    </OnboardShell>
  );

  // 25–35s: identity, framed as saving what you already did. With a way out.
  if (step === 2) return (
    <OnboardShell>
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Your call is in</div>
      <div className="text-3xl font-extrabold tracking-tight mt-2">Save it under a name.</div>
      <p className="text-[14px] text-white/60 mt-2 max-w-xs">So your squad knows who called it, and your record follows you.</p>
      <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} placeholder="Kev"
        className="mt-5 w-full max-w-xs h-12 rounded-xl bg-white/10 border border-white/20 px-4 text-white placeholder-white/30 text-center text-lg font-bold" />
      <button disabled={!name.trim()} onClick={() => { onSaveName?.(name.trim()); setStep(3); }}
        className="mt-4 w-full max-w-xs py-3.5 rounded-2xl bg-white text-[var(--ink)] text-lg font-bold disabled:opacity-30">Save my call</button>
      <button className="mt-3 mono text-[11px] text-white/40" onClick={() => setStep(3)}>later</button>
    </OnboardShell>
  );

  // 35–45s: the un-voidable sentence — a promise about something you now hold.
  if (step === 3) return (
    <OnboardShell>
      <div className="mx-auto"><OnbMark kind="paid" /></div>
      <div className="text-3xl font-extrabold tracking-tight mt-5">When you win, the pool pays you.</div>
      <p className="text-[16px] text-white/75 mt-3 leading-relaxed max-w-xs">
        No one can void it, limit you, or hold your payout. Every win comes with a receipt you can check.
      </p>
      <OnboardNext label="Good" onClick={() => setStep(4)} onSkip={onDone} />
    </OnboardShell>
  );

  // 45–60s: the soft push ask, after the value. Then the share back to the chat.
  return (
    <OnboardShell>
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">One last thing</div>
      <div className="text-3xl font-extrabold tracking-tight mt-2">Want a nudge when it lands?</div>
      <p className="text-[14px] text-white/60 mt-2 max-w-xs">We&apos;ll ping you when your call settles, and when the Freeze opens. Nothing else, ever.</p>
      <button onClick={async () => { await onAskPush?.(); onDone(); }} className="mt-6 w-full max-w-xs py-3.5 rounded-2xl bg-white text-[var(--ink)] text-lg font-bold">Yes, ping me</button>
      <button onClick={() => { onShare?.(); onDone(); }} className="mt-2 w-full max-w-xs py-3.5 rounded-2xl bg-white/15 text-white font-bold">Share it to the chat</button>
      <button className="mt-3 mono text-[11px] text-white/40" onClick={onDone}>not now</button>
    </OnboardShell>
  );

}

/** The Wake (N1) — elimination-night ritual. Detects, from real results, whether the fan's nation lost
 * its most recent knockout match; if so, an honest eulogy. Silent while the nation is still alive. */
function TheWake({ nation }: { nation: string }) {
  const [w, setW] = useState<{ out: boolean; opp: string; score: string } | null>(null);
  useEffect(() => {
    let live = true; setW(null);
    (async () => {
      try {
        const fixtures = await getFixtures();
        const mine = (fixtures as any[])
          .filter((f) => (f.home === nation || f.away === nation) && f.state === "finished")
          .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        if (!mine.length) return;
        const f = mine[0];
        const sc = await fetch(`/api/scores/${f.fixtureId}`).then((r) => r.json());
        const last = sc?.recent?.length ? sc.recent[sc.recent.length - 1]?.Stats : null;
        if (!last) return;
        const hg = Number(last["1"] || 0), ag = Number(last["2"] || 0);
        const isHome = f.home === nation;
        const myG = isHome ? hg : ag, oppG = isHome ? ag : hg;
        if (live) setW({ out: myG < oppG, opp: isHome ? f.away : f.home, score: `${myG}–${oppG}` });
      } catch { /* leave silent */ }
    })();
    return () => { live = false; };
  }, [nation]);
  if (!w || !w.out) return null;
  return (
    <div className="mt-2 rounded-2xl p-5 text-white" style={{ background: "linear-gradient(135deg,#1c1c1e,#0e0e0f)" }}>
      <div className="mono text-[10px] tracking-widest uppercase text-white/50">The Wake</div>
      <div className="flex items-center gap-2 mt-2"><Flag name={nation} size={22} round /><div className="text-lg font-bold">{nation}&apos;s World Cup is over.</div></div>
      <div className="text-sm text-white/70 mt-1.5">Out {w.score} to {w.opp}. You flew the flag to the end — that counts. Adopt a second below and ride it to the final.</div>
    </div>
  );
}

/** Match recap (G4/T5) — the real full-time score + a stat, derived from the same event feed the kernel
 * settles on (Stats[1]=home goals, [2]=away, [7/8]=corners). A reason to open between matches; renders
 * only when there's usable data (never a fabricated scoreline). */
function MatchRecap({ fixtureId, home, away, onRelive }: { fixtureId: number; home: string; away: string; onRelive?: (id: number) => void }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => { let live = true; setS(null); fetch(`/api/scores/${fixtureId}`).then((r) => r.json()).then((x) => { if (live) setS(x); }).catch(() => {}); return () => { live = false; }; }, [fixtureId]);
  const last = s?.recent?.length ? s.recent[s.recent.length - 1]?.Stats : null;
  if (!last) return null;
  const hg = Number(last["1"] || 0), ag = Number(last["2"] || 0), hc = Number(last["7"] || 0), ac = Number(last["8"] || 0);
  if (hg === 0 && ag === 0 && hc === 0 && ac === 0) return null; // no usable data → show nothing
  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Full time</div>
      <div className="flex items-center justify-center gap-3 mt-2.5">
        <span className="flex items-center gap-2 flex-1 justify-end"><span className="font-bold text-right leading-tight">{home}</span><Flag name={home} size={20} round /></span>
        <span className="text-2xl font-extrabold tabular-nums px-1">{hg}<span className="text-[var(--muted)] mx-1.5">–</span>{ag}</span>
        <span className="flex items-center gap-2 flex-1"><Flag name={away} size={20} round /><span className="font-bold leading-tight">{away}</span></span>
      </div>
      <div className="mono text-[10px] text-[var(--muted)] text-center mt-2.5">corners {hc}–{ac} · settled on the real feed</div>
      {/* Q8 — replay it anonymised, as a three-minute drama run off the same tick stream. */}
      {onRelive && (
        <button onClick={() => onRelive(fixtureId)} className="mt-3 w-full py-2.5 rounded-xl border-2 border-[var(--line)] font-bold text-sm active:scale-[0.99] transition-transform">
          Relive it — no names, 3 minutes
        </button>
      )}
    </div>
  );
}

/** The knockout board — every match as it moves LIVE → FT, straight from the live fixtures feed. A
 * tournament-wide overview (the "living bracket" in board form); tap a match to make it your focus. */
function KnockoutBoard({ fixtures, onSelect }: { fixtures: any[]; onSelect: (id: number) => void }) {
  const [q, setQ] = useState("");
  if (!fixtures || fixtures.length === 0) return null;
  const rank = (f: any) => (f.state === "inplay" ? 0 : f.state === "soon" ? 1 : 2);
  const term = q.trim().toLowerCase();
  const matched = term ? fixtures.filter((f: any) => `${f.home} ${f.away}`.toLowerCase().includes(term)) : fixtures;
  const rows = [...matched].sort((a, b) => rank(a) - rank(b) || (a.startTime || 0) - (b.startTime || 0)).slice(0, 12);
  const chip = (f: any) => (f.state === "inplay" ? { t: "LIVE", c: "text-[var(--green)]" } : f.state === "finished" ? { t: "FT", c: "text-[var(--muted)]" } : { t: "SOON", c: "text-[var(--muted)]" });
  return (
    <div className="mt-6">
      <div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF] mb-2">The knockout · live board</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a team…" className="w-full h-9 rounded-xl border border-[var(--line)] px-3.5 bg-white text-sm mb-2" />
      <div className="bg-white border border-[var(--line)] rounded-2xl overflow-hidden">
        {rows.length === 0 && <div className="px-4 py-4 text-sm text-[var(--muted)] text-center">No match for “{q}”.</div>}
        {rows.map((f) => { const c = chip(f); return (
          <button key={f.fixtureId} onClick={() => onSelect(f.fixtureId)} className="w-full flex items-center gap-2.5 px-4 py-3 border-b border-[#F1F1EF] last:border-0 text-left active:bg-[#FAFAF7]">
            <FlagPair home={f.home} away={f.away} size={16} />
            <span className="flex-1 text-sm font-medium truncate">{f.home} <span className="text-[var(--muted)]">v</span> {f.away}</span>
            <span className={`mono text-[9px] uppercase tracking-widest ${c.c}`}>{c.t}</span>
          </button>
        ); })}
      </div>
    </div>
  );
}

/** Drama Meter (L3) — narrative bands read from the live TxLINE market: the tighter home vs away, the
 * more it's "on". Pre-match tension from the real de-margined 1X2; in-play it rides the swings the same
 * way. Never a fabricated number — the band is a plain function of the live implied %. */
function DramaMeter({ fixtureId }: { fixtureId: number }) {
  const [o, setO] = useState<any>(null);
  useEffect(() => { let live = true; fetch(`/api/odds/${fixtureId}`).then((r) => r.json()).then((d) => { if (live) setO(d); }).catch(() => {}); return () => { live = false; }; }, [fixtureId]);
  if (!o || !o.hasOdds) return null;
  const gap = Math.abs((o.home || 0) - (o.away || 0));
  const band = gap <= 8 ? { t: "GOING TO THE WIRE", c: "#dc2626", w: 92 } : gap <= 18 ? { t: "WOBBLING", c: "#f59e0b", w: 68 } : gap <= 30 ? { t: "IN THE BALANCE", c: "#059669", w: 46 } : { t: "CRUISING", c: "#6b7280", w: 24 };
  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="flex items-center justify-between"><span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Drama meter</span><span className="mono text-[10px] font-extrabold" style={{ color: band.c }}>{band.t}</span></div>
      <div className="mt-2.5 h-2.5 rounded-full bg-[#FAFAF7] overflow-hidden"><div className="h-full transition-all duration-700" style={{ width: `${band.w}%`, background: band.c }} /></div>
      <div className="mono text-[9px] text-[var(--muted)] mt-2">Read from the live market — the tighter the odds, the more it&apos;s on.</div>
    </div>
  );
}

/** Fans vs the Market (G1, market half) — the live de-margined 1X2 implied % from TxLINE, as a bar the
 * fan can read against their own gut. Renders only when a market is actually open (the match is live/soon);
 * absent otherwise so Today stays clean. Uses the real feed — never a fabricated number. */
function MarketRead({ fixtureId, home, away }: { fixtureId: number; home: string; away: string }) {
  const [o, setO] = useState<any>(null);
  const [pick, setPick] = useState<number | null>(null); // 0 home · 1 draw · 2 away — the fan's own read
  const [read, setRead] = useState<string>("");          // The Gaffer's Read — AI on a live line move
  const prev = useRef<{ home: number; draw: number; away: number } | null>(null);

  // Poll the line so the bar moves in real time, and when it lurches (≥6 implied-% points on a side) ask
  // the AI to explain what a swing that size signals — the consumer-facing side of the deployed explainer
  // agent. Honest by construction: /api/explain-move reads the market only, never invents an event.
  useEffect(() => {
    setPick(null); setRead(""); prev.current = null;
    let live = true;
    const read1 = async () => {
      try {
        const d = await fetch(`/api/odds/${fixtureId}`).then((r) => r.json());
        if (!live) return;
        setO(d);
        if (d?.hasOdds) {
          const now = { home: d.home, draw: d.draw, away: d.away };
          const p = prev.current;
          // Record this tick's line synchronously, BEFORE any await — otherwise a fixture switch during the
          // explain-move fetch would let this stale closure write the old fixture's odds over the new one's
          // freshly-reset ref, corrupting the next diff.
          prev.current = now;
          if (p) {
            let side = "", from = 0, to = 0, best = 0;
            for (const k of ["home", "draw", "away"] as const) { const mv = Math.abs((now[k] ?? 0) - (p[k] ?? 0)); if (mv >= 6 && mv > best) { best = mv; side = k; from = p[k]; to = now[k]; } }
            if (side) {
              const r = await fetch(`/api/explain-move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ home, away, side, from, to }) }).then((x) => x.json()).catch(() => null);
              if (live && r?.line) setRead(r.line);
            }
          }
        }
      } catch { /* transient — try again next tick */ }
    };
    read1();
    const t = POLL ? setInterval(read1, 20_000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [fixtureId, home, away]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o || !o.hasOdds) return null;
  const segs = [{ k: home, v: o.home, c: "var(--green)" }, { k: "Draw", v: o.draw, c: "#9CA3AF" }, { k: away, v: o.away, c: "#f59e0b" }];
  const chosen = pick != null ? segs[pick] : null;
  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Fans vs the market</div>
      <div className="mt-2.5 flex h-3 rounded-full overflow-hidden bg-[#FAFAF7]">
        {segs.map((s, i) => (<div key={i} style={{ width: `${s.v}%`, background: s.c }} className="transition-all duration-500" />))}
      </div>
      <div className="mt-2 flex justify-between text-[11px]">
        {segs.map((s, i) => (<span key={i} className="font-semibold"><span className="tabular-nums">{s.v}%</span> <span className="text-[var(--muted)]">{s.k}</span></span>))}
      </div>
      <div className="mono text-[9px] text-[var(--muted)] mt-2.5 mb-1.5">The market&apos;s read, de-margined. What&apos;s YOUR call?</div>
      <div className="flex gap-1.5">
        {segs.map((s, i) => (<button key={i} onClick={() => setPick(i)} className={`flex-1 h-9 rounded-lg text-[13px] font-bold transition-colors ${pick === i ? "bg-[var(--ink)] text-white" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{s.k}</button>))}
      </div>
      {chosen && (
        <div className={`mt-2.5 rounded-lg px-3 py-2 text-[12px] font-semibold ${chosen.v <= 30 ? "bg-[var(--green)]/10 text-[var(--green)]" : "bg-[#FAFAF7] text-[var(--muted)]"}`}>
          {chosen.v <= 30 ? `You're calling it against the book — only ${chosen.v}% are on ${chosen.k}. Bold.` : `You're with the market — ${chosen.k} at ${chosen.v}%.`}
        </div>
      )}
      {read && (
        <div className="mt-2.5 rounded-lg px-3 py-2.5 bg-[var(--ink)] text-white">
          <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] gf-pulse" /><span className="mono text-[9px] tracking-widest uppercase text-[var(--greenb)]">The Gaffer&apos;s Read · live</span></div>
          <div className="text-[12.5px] font-semibold mt-1 leading-snug">{read}</div>
        </div>
      )}
    </div>
  );
}

/** The Play hub (§12.2) — every game as a state-card, rendered from the single feature registry
 * (features.ts). Live games deep-link to their tab; unbuilt ones show "soon" and can't be tapped. */
function PlayHub({ onGo, onRelive, reliveId }: { onGo: (tab: string) => void; onRelive?: (id: number) => void; reliveId?: number | null }) {
  return (
    <div className="mt-6">
      <div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF] mb-2">More ways to play</div>
      <div className="grid grid-cols-2 gap-2">
        {GAMES.map((g) => (
          <button key={g.id} disabled={g.status === "soon" || (g.id === "mystery" && !reliveId)} onClick={() => g.status === "live" && (g.id === "mystery" ? (reliveId && onRelive?.(reliveId)) : onGo(g.tab))} className={`text-left rounded-2xl p-3.5 border ${g.status === "live" ? "bg-white border-[var(--line)] active:scale-[0.98] transition-transform" : "bg-[#FAFAF7] border-dashed border-[var(--line)] opacity-70 cursor-default"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold leading-tight">{g.name}</span>
              {g.status === "live" ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] shrink-0" /> : <span className="mono text-[8px] tracking-widest uppercase text-[var(--muted)] shrink-0">soon</span>}
            </div>
            <div className="text-[11px] text-[var(--muted)] mt-1 leading-snug">{g.blurb}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Daily goals — the endowed-progress nudge (T2). Progress is derived live from real actions the fan
 * has already taken (free pick / a staked call / an alive streak) — never a fake counter. */
/** Y7 — a drawn medal (never an emoji): a filled disc with a ribbon notch, tinted by tier. */
function Medal({ tier, size = 18 }: { tier: "gold" | "silver" | "bronze"; size?: number }) {
  const fill = tier === "gold" ? "#D8A32B" : tier === "silver" ? "#A8AFB5" : "#B0754A";
  const rim = tier === "gold" ? "#B98718" : tier === "silver" ? "#8B9298" : "#8E5A36";
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-label={`${tier} medal`} role="img" className="shrink-0">
      <circle cx="10" cy="11.5" r="6.5" fill={fill} stroke={rim} strokeWidth="1.2" />
      <path d="M6.6 5.2 4.4 1.4h3.1l1.9 3.3zM13.4 5.2l2.2-3.8h-3.1l-1.9 3.3z" fill={rim} />
      <circle cx="10" cy="11.5" r="3.1" fill="none" stroke={rim} strokeWidth="0.9" opacity="0.65" />
    </svg>
  );
}

/** T2 — the daily quest board. Every tick is SERVER-VERIFIED (derived from the points ledger the
 * server itself wrote), so a quest can never be completed by a client that merely says so. A medal
 * lands at 1/2/3 done (bronze/silver/gold), and the weekly board of 10 opens beneath it — two of
 * which arrive pre-completed (endowed progress: 34% vs 19% completion, Nunes & Drèze). */
function QuestBoard({ econ }: { econ: Economy | null }) {
  const [showWeek, setShowWeek] = useState(false);
  const quests = econ?.quests?.quests ?? [];
  const done = econ?.quests?.done ?? 0;
  const total = econ?.quests?.total ?? 3;
  const medal = econ?.quests?.medal ?? null;
  const week = econ?.weeklyBoard;

  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Today&apos;s goals</span>
        <span className="flex items-center gap-1.5">
          {medal ? <Medal tier={medal} size={16} /> : null}
          <span className="mono text-[10px] font-bold text-[var(--green)]">{done}/{total} done</span>
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {quests.length
          ? quests.map((q) => (
            <div key={q.id} className="flex items-center gap-2.5">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 ${q.done ? "bg-[var(--green)] text-white" : "border-2 border-[var(--line)] text-transparent"}`}>✓</span>
              <span className={`text-sm ${q.done ? "text-[var(--muted)] line-through" : "font-semibold"}`}>{q.label}</span>
            </div>
          ))
          : [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="w-5 h-5 rounded-full shrink-0" />
              <Skeleton className={`h-3.5 ${i === 0 ? "w-40" : i === 1 ? "w-44" : "w-36"}`} />
            </div>
          ))}
      </div>
      {done < total ? (
        <div className="mt-3 h-1.5 rounded-full bg-[#FAFAF7] overflow-hidden"><div className="h-full bg-[var(--green)] transition-all duration-500" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></div>
      ) : (
        <div className="mt-3 text-[12px] font-bold text-[var(--green)]">All done — you&apos;re on a roll. Back tomorrow to keep it going.</div>
      )}

      {week ? (
        <>
          <button onClick={() => setShowWeek((v) => !v)} className="mt-3 w-full text-left mono text-[10px] tracking-widest uppercase text-[var(--muted)] flex items-center justify-between">
            <span>This week · {week.done}/{week.total}</span>
            <span className="text-[var(--green)] font-bold">{showWeek ? "hide" : "show"}</span>
          </button>
          <div className="mt-2 h-1.5 rounded-full bg-[#FAFAF7] overflow-hidden"><div className="h-full bg-[var(--green)] transition-all duration-700" style={{ width: `${(week.done / Math.max(1, week.total)) * 100}%` }} /></div>
          {showWeek ? (
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {week.items.map((it) => (
                <div key={it.id} className="flex items-center gap-1.5">
                  <span className={`w-3.5 h-3.5 rounded-full shrink-0 ${it.done ? "bg-[var(--green)]" : "border-2 border-[var(--line)]"}`} />
                  <span className={`text-[11px] ${it.done ? "text-[var(--muted)]" : "font-medium"}`}>{it.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** T5 — "Day N at the Cup": the day told back to the room, from numbers we already have. A quiet day is
 * allowed to be quiet rather than padded with a highlight that didn't happen. */
function RecapCard() {
  const [r, setR] = useState<any>(null);
  useEffect(() => { fetch("/api/recap").then((x) => x.json()).then(setR).catch(() => {}); }, []);
  if (!r || r.empty || r.day <= 0) return null;
  const hasSomething = r.biggestWin || r.boldestCall || r.poolsSettled > 0;
  if (!hasSomething) return null;
  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">{r.dayLabel}</span>
        {r.players > 0 ? <span className="mono text-[10px] text-[var(--muted)]">{r.players} playing</span> : null}
      </div>
      {r.biggestWin ? (
        <div className="mt-2 text-sm"><b>{r.biggestWin.name}</b> turned {fmtAmt(r.biggestWin.stake)} into <b className="text-[var(--green)]">{fmtAmt(r.biggestWin.payout)}</b> on “{r.biggestWin.question}”.</div>
      ) : null}
      {r.boldestCall ? (
        <div className="mt-1 text-[12px] text-[var(--muted)]">Boldest call that landed: <b className="text-[var(--ink)]">{r.boldestCall.name}</b> at {r.boldestCall.calledAt}% — the room said no.</div>
      ) : null}
      <div className="mt-2 flex items-center gap-3 mono text-[10px] text-[var(--muted)]">
        {r.poolsSettled > 0 ? <span>{r.poolsSettled} pools settled</span> : null}
        {r.roomAccuracy != null ? <span>room read {r.roomAccuracy}% right</span> : null}
      </div>
    </div>
  );
}

/** T4 — the rollover headline pot. Every remainder a settled pool leaves behind (rounding dust and
 * anything never collected) carries into the next day's headline pool. It is a real, on-chain number
 * read back off the vaults — it only ever grows, and it is never shown as a rounded-up guess. */
function RolloverPot({ econ }: { econ: Economy | null }) {
  const pot = econ?.rollover;
  // Hide until it would actually read as a number. Rounding dust starts at a few lamports; printing
  // "0.000 coins" is worse than printing nothing, and we never round a pot up to look bigger.
  if (!pot || pot.sol < 0.0005) return null;
  return (
    <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white relative overflow-hidden">
      <div className="absolute -right-8 -top-10 w-32 h-32 rounded-full bg-[var(--green)] opacity-[0.16] blur-2xl" />
      <span className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Rolls into tomorrow</span>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-3xl font-black tabular-nums">{pot.sol.toFixed(3)}</span>
        <span className="mono text-[11px] opacity-70">coins</span>
      </div>
      <p className="mt-1 text-[12px] opacity-75 leading-snug">
        Left over from {pot.sources} settled {pot.sources === 1 ? "pool" : "pools"}. Nobody keeps it — it grows tomorrow&apos;s headline pot.
      </p>
    </div>
  );
}

/** T7 — the Mystery booster. Visible from day one as a sealed slot; what's inside is genuinely unknown
 * (the server won't say) until the knockouts. It is not a badge: once played it arms Double Down, and
 * the next correct call really does pay twice, on the ledger. */
function MysterySlot({ econ, onPlay, busy }: { econ: Economy | null; onPlay: () => void; busy?: boolean }) {
  const m = econ?.boosters?.mystery;
  if (!m) return null;
  const dateLabel = new Date(m.revealsOn + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (!m.revealed) {
    return (
      <div className="mt-4 rounded-2xl p-4 border-2 border-dashed border-[var(--line)] bg-white flex items-center gap-3.5">
        <div className="w-11 h-11 rounded-xl bg-[#FAFAF7] border border-[var(--line)] flex items-center justify-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><path d="M10 3v14M3 10h14" stroke="#C9CBC7" strokeWidth="2.4" strokeLinecap="round" /></svg>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold">A booster is sealed in here.</div>
          <div className="text-[12px] text-[var(--muted)]">Nobody finds out what it does until the knockouts — {dateLabel}.</div>
        </div>
      </div>
    );
  }
  if (m.spent) {
    return (
      <div className="mt-4 rounded-2xl p-4 bg-white border border-[var(--line)]">
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">{m.name}</div>
        <div className="text-sm font-bold mt-0.5">Played. It doubled your call.</div>
      </div>
    );
  }
  if (m.armed) {
    return (
      <div className="mt-4 rounded-2xl p-4 bg-[var(--green)]/10 border border-[var(--green)]/30">
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">{m.name} · armed</div>
        <div className="text-sm font-bold mt-0.5">Your next correct call pays double.</div>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white">
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Booster unsealed</div>
      <div className="text-lg font-black mt-0.5">{m.name}</div>
      <p className="text-[12px] opacity-75 mt-0.5">{m.blurb}</p>
      <button onClick={onPlay} disabled={busy} className="mt-3 w-full py-2.5 rounded-xl bg-white text-[var(--ink)] font-bold text-sm disabled:opacity-40">Play it</button>
      <p className="text-[11px] opacity-60 mt-1.5">One only. Once it&apos;s gone, it&apos;s gone.</p>
    </div>
  );
}

/** T6 — the late-join promise, stated plainly, and the knockout-only entry as a real, first-class flow.
 * The single most-begged-for thing in every World Cup pool thread: "can I still join?" The answer has to
 * be yes, and it has to be a button — not a paragraph. */
function KnockoutEntry({ econ, onEnter, busy, name }: { econ: Economy | null; onEnter: () => void; busy?: boolean; name: string }) {
  const k = econ?.knockouts;
  if (!k) return null;
  const startLabel = new Date(k.startsOn + "T00:00:00Z").toLocaleDateString(undefined, { month: "long", day: "numeric" });

  if (k.entered && k.open && k.size > 0) {
    return (
      <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Knockout board</span>
          <span className="mono text-[10px] font-bold text-[var(--green)]">#{k.rank} of {k.size}</span>
        </div>
        <div className="mt-3 space-y-1.5">
          {k.rows.slice(0, 5).map((r) => (
            <div key={r.userId} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${r.you ? "bg-[#F1F7F3]" : ""}`}>
              <span className="mono text-[11px] w-5 text-[var(--muted)] tabular-nums">{r.rank}</span>
              {r.rank <= 3 ? <Medal tier={r.rank === 1 ? "gold" : r.rank === 2 ? "silver" : "bronze"} size={15} /> : <span className="w-[15px]" />}
              <span className={`text-sm flex-1 truncate ${r.you ? "font-black" : "font-medium"}`}>{r.you ? `${name || "You"} (you)` : `Caller ${r.userId.slice(0, 4)}`}</span>
              <span className="mono text-[12px] font-bold tabular-nums">{r.points}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (k.entered) {
    return (
      <div className="mt-4 rounded-2xl p-4 bg-[var(--green)]/10 border border-[var(--green)]/30">
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">You&apos;re in</div>
        <div className="text-sm font-bold mt-0.5">The knockout board opens {startLabel}.</div>
        <p className="text-[12px] text-[var(--muted)] mt-0.5">Everyone starts level. Nothing before it counts.</p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white relative overflow-hidden">
      <div className="absolute -right-10 -bottom-12 w-36 h-36 rounded-full bg-[var(--green)] opacity-[0.14] blur-2xl" />
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Joined late?</div>
      <div className="text-lg font-black mt-0.5 leading-tight">You haven&apos;t missed it.</div>
      <p className="text-[12px] opacity-75 mt-1 leading-snug">
        The knockout board starts everyone level on {startLabel}. Turn up then and you can still win the whole thing.
      </p>
      <button onClick={onEnter} disabled={busy} className="mt-3 w-full py-2.5 rounded-xl bg-white text-[var(--ink)] font-bold text-sm disabled:opacity-40">
        Enter the knockout board
      </button>
    </div>
  );
}

/** Y3 — status tier. Read from LIFETIME EARNED, so spending points can never demote you (the fix for
 * the hoarding failure every points economy hits). The bar shows the climb to the next rank. */
function TierCard({ econ }: { econ: Economy | null }) {
  if (!econ?.tier) return null;
  const t = econ.tier;
  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Your rank</span>
        <span className="mono text-[10px] text-[var(--muted)]">{econ.lifetimeEarned.toLocaleString()} earned</span>
      </div>
      <div className="mt-1 text-xl font-black">{t.name}</div>
      {t.next ? (
        <>
          <div className="mt-2 h-1.5 rounded-full bg-[#FAFAF7] overflow-hidden">
            <div className="h-full bg-[var(--green)] transition-all duration-700" style={{ width: `${Math.min(100, Math.max(2, t.pct))}%` }} />
          </div>
          <p className="mt-1.5 text-[12px] text-[var(--muted)]">{t.toNext.toLocaleString()} more to reach <b className="text-[var(--ink)]">{t.next}</b>.</p>
        </>
      ) : (
        <p className="mt-1.5 text-[12px] font-bold text-[var(--green)]">Top rank. Nothing above this.</p>
      )}
      <p className="mt-2 text-[11px] text-[var(--muted)] leading-snug">Ranks are earned for life. Spending never takes one back.</p>
    </div>
  );
}

/** Y3 — the weekly league of 30. Resets Monday; everyone you can actually catch is on this one table. */
function LeagueTable({ econ, name }: { econ: Economy | null; name: string }) {
  const L = econ?.league;
  if (!L || !L.rows?.length) return null;
  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">League {L.league} · this week</span>
        <span className="mono text-[10px] font-bold text-[var(--green)]">#{L.rank} of {L.size}</span>
      </div>
      <div className="mt-3 space-y-1.5">
        {L.rows.slice(0, 8).map((r) => (
          <div key={r.userId} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${r.you ? "bg-[#F1F7F3]" : ""}`}>
            <span className="mono text-[11px] w-5 text-[var(--muted)] tabular-nums">{r.rank}</span>
            {r.rank <= 3 ? <Medal tier={r.rank === 1 ? "gold" : r.rank === 2 ? "silver" : "bronze"} size={15} /> : <span className="w-[15px]" />}
            <span className={`text-sm flex-1 truncate ${r.you ? "font-black" : "font-medium"}`}>{r.you ? `${name || "You"} (you)` : `Caller ${r.userId.slice(0, 4)}`}</span>
            <span className="mono text-[12px] font-bold tabular-nums">{r.points}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** T3 — the Streak Wager. Duolingo's own A/B put this at +14% D7, their best-measured mechanic.
 * Stake points that your run survives a week; double them if it does. Losing costs only the stake —
 * never your run, never real money. Earn-Back repairs a dead run once, for points. */
function WagerCard({ econ, onWager, onEarnBack, busy }: { econ: Economy | null; onWager: () => void; onEarnBack: () => void; busy?: boolean }) {
  if (!econ) return null;
  const w = econ.wager, terms = econ.wagerTerms, alive = econ.streak > 0;
  const daysIn = w && w.status === "open" ? Math.max(0, Math.floor(Date.now() / 86400000) - w.startDay) : 0;

  if (w?.status === "open") {
    return (
      <div className="bg-white border border-[var(--line)] rounded-2xl p-4">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Streak wager</span>
        <div className="mt-1 text-sm font-bold">{w.stake} riding on {w.targetDays} days.</div>
        <div className="mt-2 flex gap-1">
          {Array.from({ length: w.targetDays }).map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i < Math.min(econ.streak, w.targetDays) ? "bg-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`} />
          ))}
        </div>
        <p className="mt-2 text-[12px] text-[var(--muted)]">Day {Math.min(econ.streak, w.targetDays)} of {w.targetDays}. Keep the run alive and it pays {w.payout}.</p>
      </div>
    );
  }
  if (w?.status === "won") return <div className="bg-[#F1F7F3] border border-[var(--green)] rounded-2xl p-4"><span className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Wager won</span><div className="mt-1 text-sm font-bold">Your run held. {w.payout} banked.</div></div>;

  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4">
      <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Streak wager</span>
      {alive ? (
        <>
          <div className="mt-1 text-sm font-bold">Put {terms.stake} on your run lasting {terms.targetDays} days.</div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">It survives → <b className="text-[var(--ink)]">{terms.payout}</b>. It doesn&apos;t → you lose the {terms.stake}. Nothing else, ever.</p>
          <button onClick={onWager} disabled={busy || econ.points < terms.stake}
            className="mt-3 w-full py-2.5 rounded-xl bg-[var(--dark)] text-white font-bold text-sm disabled:opacity-40">
            {econ.points < terms.stake ? `Need ${terms.stake} points` : `Place the wager`}
          </button>
        </>
      ) : (
        <>
          <div className="mt-1 text-sm font-bold">Your run is out.</div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Repair it once for 100 points and pick up where you left off.</p>
          <button onClick={onEarnBack} disabled={busy || econ.points < 100}
            className="mt-3 w-full py-2.5 rounded-xl border-2 border-[var(--line)] font-bold text-sm disabled:opacity-40">
            {econ.points < 100 ? "Need 100 points" : "Earn it back — 100"}
          </button>
        </>
      )}
    </div>
  );
}

/** T3 — a milestone card, minted the first time a run reaches 3 / 7 / 14 / 21 / 33 days. */
function MilestoneCard({ days, onShare, onClose }: { days: number; onShare: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] bg-[var(--dark)]/90 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-3xl p-6 w-full max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-fit"><Medal tier={days >= 21 ? "gold" : days >= 7 ? "silver" : "bronze"} size={44} /></div>
        <div className="mt-3 text-4xl font-black tabular-nums">{days}</div>
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">day run</div>
        <p className="mt-3 text-sm text-[var(--muted)]">You&apos;ve shown up {days} days straight. Most people never get here.</p>
        <div className="mt-5 flex gap-2">
          <button onClick={onShare} className="flex-1 py-3 rounded-xl bg-[var(--green)] text-white font-bold text-sm">Share it</button>
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border-2 border-[var(--line)] font-bold text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

function Today({ markets, loading, label, busy, spinUp, askMarket, onGoal, setSheet, settle, claim, setDetail, streak, freezes, freePicked, freePick, addToSlip, parlays, positions = [], settleParlayFn, claimParlayFn, fadeParlayFn, fixtures = [], selectedFixture, onSelectFixture, userId, onHiloPoints, onGo, econ, onEnterKnockouts, onPlayMystery, econBusy, userName, onRelive, onAmbient }: any) {
  // Only surface pools that are genuinely OPEN — status live, before the lock cut-off (KILL-1), a real
  // market, and ON THE MATCH THE FAN PICKED. `nowSec` ticks in an effect so render stays pure.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10000); return () => clearInterval(t); }, []);
  // Q8 — "any finished game", not just one still on today's slate. The server reports which fixtures
  // actually have a finished tick stream to run.
  const [replayable, setReplayable] = useState<{ fixtureId: number; home: string; away: string }[]>([]);
  useEffect(() => { mysteryList().then(setReplayable).catch(() => {}); }, []);
  const latestFinished: number | null = replayable.length ? replayable[0].fixtureId : null;
  const onFixture = (m: MarketView) => !selectedFixture || Number(m.fixtureId) === selectedFixture;
  const open = markets.filter((m: MarketView) => m.status === 0 && Number(m.lockTs) > nowSec && realMarket(m) && onFixture(m));
  // "Ready to collect" shows only settled pools YOU were in and can still collect.
  // You can collect when the side you backed is the side that won. SETTLED_YES pays YES (1);
  // SETTLED_NO pays NO (2) — the ending that could not exist before `settle_no`.
  const heldWinning = (m: MarketView) => positions.some((p: any) =>
    p.market === m.pubkey && !p.claimed && p.amount > 0 && p.side === wonSide(m));
  const settled = markets.filter((m: MarketView) => isPaid(m) && realMarket(m) && heldWinning(m));
  const sel = fixtures.find((f: any) => f.fixtureId === selectedFixture);
  const selName = FIXTURE_NAMES[String(selectedFixture)] ? `${FIXTURE_NAMES[String(selectedFixture)].home} v ${FIXTURE_NAMES[String(selectedFixture)].away}` : "the match";

  /* Matchday.
   *
   * Today is a day lobby: a free call, three quests, a knockout board, a sealed booster. All of it is
   * beside the point at minute 34 of a match you are watching. When the clock is running, the match comes
   * first — the score, your position, the pools you can still call — and the lobby waits below. */
  const [pulse, setPulse] = useState<any>(null);
  const matchOn = !!pulse && (pulse.running || pulse.atHalftime);

  const lobby = (
    <>
      <QuestBoard econ={econ} />
      <RecapCard />
      <RolloverPot econ={econ} />
      <KnockoutEntry econ={econ} onEnter={onEnterKnockouts} busy={econBusy} name={userName} />
      <MysterySlot econ={econ} onPlay={onPlayMystery} busy={econBusy} />
    </>
  );

  return (
    <div>
      <MatchBar fixtures={fixtures} selected={selectedFixture} onSelect={onSelectFixture} />
      <LiveNow fixtureId={selectedFixture} markets={markets} positions={positions} onOpen={setDetail} onGoal={onGoal} onPulse={setPulse} />
      {/* Ambient mode belongs beneath the match it is about, and only while there is a match to lean back
          and watch. It used to float over the card stack as an unlabelled glyph, covering whatever pool sat
          under it; before kickoff, with no live card above it, it reads as an orphaned bar. */}
      {matchOn && (
        <button onClick={() => onAmbient?.()} className="w-full mb-3 py-2.5 rounded-xl border border-[var(--line)] bg-white mono text-[10px] tracking-widest uppercase text-[var(--muted)]">
          Ambient mode
        </button>
      )}
{!matchOn && (<>
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white relative overflow-hidden">
        <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full" style={{ background: "radial-gradient(circle, rgba(5,150,105,.5), transparent 70%)" }} />
        <div className="relative">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Today&apos;s free call</div>
          <p className="text-[19px] font-bold tracking-tight mt-3">Goal before half-time? <span className="text-[#9CA3AF] font-normal inline-flex items-center gap-1.5">{FIXTURE_NAMES[String(selectedFixture)] && <FlagPair home={FIXTURE_NAMES[String(selectedFixture)].home} away={FIXTURE_NAMES[String(selectedFixture)].away} size={14} />}{selName}</span></p>
          {!freePicked ? (
            <div className="flex gap-2 mt-4">
              <button onClick={() => freePick("yes")} className="flex-1 h-12 rounded-xl bg-white text-[var(--ink)] font-bold">Yes</button>
              <button onClick={() => freePick("no")} className="flex-1 h-12 rounded-xl bg-[#1d1d1f] border border-[#2c2c2e] font-bold">No</button>
            </div>
          ) : (
            <div className="flex items-end gap-3 mt-4"><div className="text-5xl font-extrabold leading-none">{streak}</div><div className="pb-1 text-[15px] font-bold leading-tight">day streak<br /><span className="text-[var(--greenb)]">still alive</span></div></div>
          )}
          <div className="flex items-center gap-1.5 mt-3">
            {Array.from({ length: 3 }).map((_, i) => (<RunTile key={i} kind={i < freezes ? "freeze" : "miss"} size={13} onDark />))}
            <span className="mono text-[10px] text-[#9CA3AF] ml-1">{freezes} freeze{freezes === 1 ? "" : "s"} · miss a day, keep your run</span>
          </div>
          <p className="text-[12px] text-[#9CA3AF] mt-2">Free. No sign-up. Keep your run — play for real when you&apos;re ready.</p>
        </div>
      </div>
</>)}

      {!matchOn && lobby}
      {selectedFixture && <MarketRead fixtureId={selectedFixture} home={fx(selectedFixture).home} away={fx(selectedFixture).away} />}
      {selectedFixture && <DramaMeter fixtureId={selectedFixture} />}
      {(() => { const sf = fixtures.find((f: any) => f.fixtureId === selectedFixture); return sf?.state === "finished" ? <MatchRecap fixtureId={selectedFixture} home={fx(selectedFixture).home} away={fx(selectedFixture).away} onRelive={onRelive} /> : null; })()}

      {DEV && <button disabled={busy === "spin"} onClick={() => spinUp(selectedFixture)} className="mt-4 w-full h-12 rounded-2xl border-2 border-dashed border-[var(--line)] text-[var(--muted)] font-semibold disabled:opacity-50">{busy === "spin" ? "Spinning up…" : `+ Spin up a pool (${selName})`}</button>}

      <AskCard onAsk={askMarket} busy={busy === "ask"} home={fx(selectedFixture).home} away={fx(selectedFixture).away} />

      <Section title={`Open pools · ${selName}`} />
      {loading && open.length === 0 && (
        <div aria-label="Loading pools">
          {[0, 1].map((i) => (
            <div key={i} className="bg-white border border-[var(--line)] rounded-2xl p-4 mb-2.5">
              <div className="flex items-center justify-between"><Skeleton className="h-2.5 w-40" /><Skeleton className="h-2.5 w-12" /></div>
              <Skeleton className="h-5 w-52 mt-2.5" />
              <Skeleton className="h-1.5 w-full mt-3 rounded-full" />
              <div className="flex gap-2 mt-3"><Skeleton className="h-11 flex-1 rounded-xl" /><Skeleton className="h-11 flex-1 rounded-xl" /></div>
            </div>
          ))}
        </div>
      )}
      {!loading && open.length === 0 && <div className="text-sm text-[var(--muted)] py-6 text-center">{sel?.state === "soon" || sel?.state === "upcoming" ? "Pools open at kick-off — lock your free call above." : "No pools open on this match yet."}</div>}
      {open.map((m: MarketView) => (
        <Card key={m.pubkey} m={m} label={label} onOpen={() => setDetail(m)}>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setSheet({ m, side: 1 })} className="flex-1 h-11 rounded-xl bg-[var(--ink)] text-white font-bold">YES</button>
            <button onClick={() => setSheet({ m, side: 2 })} className="flex-1 h-11 rounded-xl bg-white border border-[var(--ink)] font-bold">NO</button>
          </div>
          <button onClick={() => addToSlip(m)} className="mt-2 w-full h-9 rounded-lg border border-dashed border-[var(--line)] text-[var(--muted)] text-[12px] font-semibold">+ Add to slip</button>
          {DEV && <button disabled={!!busy} onClick={() => settle(m)} className="mt-2 w-full h-9 rounded-lg bg-[#FAFAF7] border border-[var(--line)] mono text-[11px] tracking-wide text-[var(--muted)] disabled:opacity-50">{busy === "settle:" + m.pubkey ? "settling…" : "settle on the proof →"}</button>}
        </Card>
      ))}

      {/* Slips are fixture-scoped exactly like pools — a slip from another match (or a dev/test one on a
          fixture that isn't in the schedule) never surfaces on the judge path. */}
      {(() => { const slips = parlays.filter((p: ParlayView) => Number(p.fixtureId) === selectedFixture); return (<>
      {slips.length > 0 && <Section title="Slips · all must land" />}
      {slips.slice(0, 5).map((p: ParlayView) => (
        <div key={p.pubkey} className="bg-white border border-[var(--line)] rounded-2xl p-4 mb-2.5">
          <div className="flex items-center justify-between">
            <span className="mono text-[10px] uppercase tracking-wide text-[#9CA3AF]">{p.legs.length}-call slip</span>
            <span className={`mono text-[10px] ${p.status === 1 ? "text-[var(--green)]" : "text-[var(--muted)]"}`}>{p.statusLabel} · {p.potSol.toFixed(2)}</span>
          </div>
          <div className="text-[13px] text-[var(--muted)] mt-1">{p.legsHit}/{p.legs.length} landed so far</div>
          {p.status === 0 && (
            <>
              <div className="mono text-[10px] text-[#9CA3AF] mt-1">all-land pool {(Number(p.yesTotal) / 1e9).toFixed(2)} · fade pool {(Number(p.noTotal) / 1e9).toFixed(2)}</div>
              <button disabled={!!busy} onClick={() => fadeParlayFn(p)} className="mt-2 w-full h-10 rounded-xl bg-white border border-[var(--ink)] text-[13px] font-bold disabled:opacity-50">{busy === "pfade:" + p.pubkey ? "…" : "Fade — bet it busts"}</button>
              {DEV && <button disabled={!!busy} onClick={() => settleParlayFn(p)} className="mt-2 w-full h-9 rounded-lg bg-[#FAFAF7] border border-[var(--line)] mono text-[11px] text-[var(--muted)]">{busy === "psettle:" + p.pubkey ? "checking…" : "check the result →"}</button>}
            </>
          )}
          {(p.status === 1 || p.status === 2 || p.status === 3) && <button disabled={!!busy} onClick={() => claimParlayFn(p)} className="mt-2 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{busy === "pclaim:" + p.pubkey ? "claiming…" : p.status === 2 ? "Get refund →" : "Claim slip →"}</button>}
        </div>
      ))}
      </>); })()}

      {/* On matchday the lobby waits its turn — the match had the top of the screen. */}
      {matchOn && (
        <>
          <Section title="While you watch" />
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white relative overflow-hidden">
        <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full" style={{ background: "radial-gradient(circle, rgba(5,150,105,.5), transparent 70%)" }} />
        <div className="relative">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Today&apos;s free call</div>
          <p className="text-[19px] font-bold tracking-tight mt-3">Goal before half-time? <span className="text-[#9CA3AF] font-normal inline-flex items-center gap-1.5">{FIXTURE_NAMES[String(selectedFixture)] && <FlagPair home={FIXTURE_NAMES[String(selectedFixture)].home} away={FIXTURE_NAMES[String(selectedFixture)].away} size={14} />}{selName}</span></p>
          {!freePicked ? (
            <div className="flex gap-2 mt-4">
              <button onClick={() => freePick("yes")} className="flex-1 h-12 rounded-xl bg-white text-[var(--ink)] font-bold">Yes</button>
              <button onClick={() => freePick("no")} className="flex-1 h-12 rounded-xl bg-[#1d1d1f] border border-[#2c2c2e] font-bold">No</button>
            </div>
          ) : (
            <div className="flex items-end gap-3 mt-4"><div className="text-5xl font-extrabold leading-none">{streak}</div><div className="pb-1 text-[15px] font-bold leading-tight">day streak<br /><span className="text-[var(--greenb)]">still alive</span></div></div>
          )}
          <div className="flex items-center gap-1.5 mt-3">
            {Array.from({ length: 3 }).map((_, i) => (<RunTile key={i} kind={i < freezes ? "freeze" : "miss"} size={13} onDark />))}
            <span className="mono text-[10px] text-[#9CA3AF] ml-1">{freezes} freeze{freezes === 1 ? "" : "s"} · miss a day, keep your run</span>
          </div>
          <p className="text-[12px] text-[#9CA3AF] mt-2">Free. No sign-up. Keep your run — play for real when you&apos;re ready.</p>
        </div>
      </div>
          {lobby}
        </>
      )}

      <HiLo userId={userId} onPoints={onHiloPoints} />

      {settled.length > 0 && <Section title="Ready to collect" />}
      {settled.slice(0, 6).map((m: MarketView) => (
        <Card key={m.pubkey} m={m} label={label} onOpen={() => setDetail(m)}>
          <button disabled={!!busy} onClick={() => claim(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{busy === "claim:" + m.pubkey ? "collecting…" : "Collect your winnings →"}</button>
        </Card>
      ))}

      <KnockoutBoard fixtures={fixtures} onSelect={onSelectFixture} />
      <PlayHub onGo={onGo} onRelive={onRelive} reliveId={latestFinished} />
    </div>
  );
}

/** The answer, above the fold.
 *
 * Apple Sports' whole thesis is that a fan wants the score before they want anything else, and
 * OneFootball is the category's cautionary tale for burying it. We were burying it too: nine stacked
 * cards and, on a match that was actually being played, no scoreline anywhere on Today.
 *
 * So this sits directly under the match rail and answers the only two questions a fan has arrived with:
 * *what's the score* and *how am I doing*. The score is read off the same signed feed everything else
 * settles on. When the feed hasn't reported a scoreline we render nothing rather than a fabricated 0–0.
 */
function LiveNow({ fixtureId, markets, positions, onOpen, onGoal, onPulse }: { fixtureId: number; markets: MarketView[]; positions: any[]; onOpen: (m: MarketView) => void; onGoal?: (msg: string) => void; onPulse?: (p: any) => void }) {
  const [pulse, setPulse] = useState<any>(null);
  const score = useRef<{ h: number; a: number } | null>(null);

  /** Poll at the speed of the match.
   *
   * A fixed fifteen seconds is fine for a fixture list and far too slow for a goal: with the server's
   * four-second cache on top, a fan could stare at a stale scoreline for nearly twenty seconds after the
   * net rippled. While the clock runs we look every four seconds; when nothing is happening we back off
   * and stop asking the feed questions it has already answered. */
  useEffect(() => {
    if (!fixtureId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    score.current = null;   // a new match starts with no scoreline to compare against

    const read = async () => {
      try {
        const p = await livePulse(fixtureId);
        if (!alive || !p) return;
        setPulse(p);
        onPulse?.(p);

        // The instant the scoreline moves, say so — this is the beat the whole app exists for.
        if (typeof p.homeGoals === "number" && typeof p.awayGoals === "number") {
          const prev = score.current;
          const f = fx(fixtureId);
          if (prev && (p.homeGoals > prev.h || p.awayGoals > prev.a)) {
            const who = p.homeGoals > prev.h ? f.home : f.away;
            onGoal?.(`GOAL — ${who}. ${f.home} ${p.homeGoals}–${p.awayGoals} ${f.away}`);
          }
          score.current = { h: p.homeGoals, a: p.awayGoals };
        }
        if (POLL && alive) timer = setTimeout(read, p.running ? 4000 : p.finished ? 60000 : 20000);
      } catch {
        if (POLL && alive) timer = setTimeout(read, 20000);
      }
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [fixtureId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pulse) return null;
  const f = fx(fixtureId);
  const clock = pulse.finished ? "FT" : pulse.atHalftime ? "HT" : pulse.clockSeconds != null ? `${Math.floor(pulse.clockSeconds / 60)}'` : null;

  // The match is in play — the market is trading in-running — but the score stream has reported no
  // scoreline yet. Say the match is live and say the score is not in yet; never stand in a fabricated
  // 0–0. This is the state a live dev-feed match sits in the whole way through: odds moving, scores mute.
  if (pulse.homeGoals == null) {
    if (!pulse.running) return null;   // not live and no score → nothing to show
    return (
      <div className="w-full bg-white border border-[var(--line)] rounded-2xl px-4 py-3 mb-3">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 flex-1 min-w-0 justify-end">
            <span className="font-bold text-right leading-tight truncate text-[15px]">{f.home}</span>
            <Flag name={f.home} size={18} round />
          </span>
          <span className="flex items-center gap-1.5 shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] gf-pulse" /><span className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Live</span></span>
          <span className="flex items-center gap-2 flex-1 min-w-0">
            <Flag name={f.away} size={18} round />
            <span className="font-bold leading-tight truncate text-[15px]">{f.away}</span>
          </span>
        </div>
        <div className="mono text-[10px] text-[var(--muted)] text-center mt-1.5">Kicked off — the market&apos;s moving. Score lands here the moment the feed calls it.</div>
      </div>
    );
  }

  // Your stake on this match, and what it's worth if it lands. One line, no navigation.
  const mine = positions
    .filter((p: any) => !p.claimed && p.amount > 0)
    .map((p: any) => ({ p, m: markets.find((x) => x.pubkey === p.market) }))
    .filter((x): x is { p: any; m: MarketView } => !!x.m && Number(x.m.fixtureId) === fixtureId && (x.m.status === 0 || (isPaid(x.m) && x.p.side === wonSide(x.m))));
  const first = mine.find((x: any) => isPaid(x.m)) || mine[0];
  const won = first ? isPaid(first.m) : false;
  const toWin = first ? heldPayout(first.m, first.p.side, first.p.amount) : 0;

  return (
    <button
      onClick={() => first && onOpen(first.m)}
      disabled={!first}
      className="w-full text-left bg-white border border-[var(--line)] rounded-2xl px-4 py-3 mb-3 disabled:cursor-default">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <span className="font-bold text-right leading-tight truncate text-[15px]">{f.home}</span>
          <Flag name={f.home} size={18} round />
        </span>
        <span className="text-[26px] font-extrabold tabular-nums leading-none px-0.5">{pulse.homeGoals}<span className="text-[var(--muted)] mx-1.5">–</span>{pulse.awayGoals}</span>
        <span className="flex items-center gap-2 flex-1 min-w-0">
          <Flag name={f.away} size={18} round />
          <span className="font-bold leading-tight truncate text-[15px]">{f.away}</span>
        </span>
      </div>
      <div className="flex items-center justify-center gap-2 mt-1.5">
        {pulse.running && <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] gf-pulse" />}
        <span className={`mono text-[10px] tracking-widest uppercase ${pulse.running ? "text-[var(--green)]" : "text-[#9CA3AF]"}`}>
          {pulse.running ? `LIVE · ${clock}` : clock}
        </span>
      </div>
      {first && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--line)] flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold truncate">
            You&apos;re on <b className={first.p.side === 1 ? "text-[var(--green)]" : ""}>{first.p.side === 1 ? "YES" : "NO"}</b> · {label(first.m).q}?
          </span>
          <span className={`text-[13px] font-extrabold shrink-0 ${won ? "text-[var(--green)]" : "text-[var(--muted)]"}`}>
            {won ? `Collect ${money(toWin)}` : `to win ≈${money(toWin)}`}
          </span>
        </div>
      )}
    </button>
  );
}

/** A live number that COUNTS UP to its new value (ease-out ~500ms) and flashes green/red in the
 * direction it moved — the trading-tape feel + the "money never just teleports" rule (§14.3). */
function TickNum({ value, className = "" }: { value: number; className?: string }) {
  const [dir, setDir] = useState("");
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const from = prev.current, to = value;
    prev.current = value;
    if (to === from) return;
    setDir(to > from ? "gf-tick-up" : "gf-tick-down");
    const clearDir = setTimeout(() => setDir(""), 950);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(to); return () => clearTimeout(clearDir); }
    const start = performance.now(), dur = 500;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / dur);
      setShown(from + (to - from) * (1 - Math.pow(1 - k, 3))); // ease-out cubic
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { clearTimeout(clearDir); if (raf.current) cancelAnimationFrame(raf.current); };
  }, [value]);
  return <span className={`${className} ${dir} inline-block tabular-nums`}>{fmtAmt(shown)}</span>;
}

function Card({ m, label, children, onOpen }: any) {
  const l = label(m);
  const yes = Number(m.yesTotal), no = Number(m.noTotal), potL = yes + no;
  const pct = potL > 0 ? Math.round((100 * yes) / potL) : 50;
  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4 mb-2.5">
      <button onClick={onOpen} className="w-full text-left">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 mono text-[10px] uppercase tracking-wide text-[#9CA3AF]"><FlagPair home={l.f.home} away={l.f.away} size={13} />{l.match}</span>
          <span className={`mono text-[10px] ${isPaid(m) ? "text-[var(--green)]" : "text-[var(--muted)]"}`}>{m.statusLabel} · <TickNum value={potL / 1e9} /></span>
        </div>
        <div className="text-[17px] font-bold tracking-tight mt-1">{l.q}?</div>
        {/* the room's belief — Polymarket's price-as-probability, in fan language */}
        {m.status === 0 && potL > 0 && (
          <div className="mt-2.5">
            <div className="flex h-1.5 rounded-full overflow-hidden bg-[#F1F1EF]">
              <div className="transition-all duration-700" style={{ width: `${pct}%`, background: "var(--green)" }} />
              <div className="transition-all duration-700" style={{ width: `${100 - pct}%`, background: "#D1D5DB" }} />
            </div>
            <div className="mt-1 mono text-[9px] tracking-wide text-[#9CA3AF]">THE ROOM: <b className="text-[var(--green)]">{pct}% YES</b> · {100 - pct}% NO</div>
          </div>
        )}
      </button>
      {children}
    </div>
  );
}

/** A shape where the content will be. "Loading your goals…" tells a fan nothing except that they are
 *  waiting; a row of three greyed rows tells them three goals are on the way. */
function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`gf-skeleton ${className}`} aria-hidden />;
}

/** The bottom bar's icons.
 *
 * Drawn, never emoji (§ no-emoji-as-UI). Stroked so they inherit the active/inactive colour from the
 * button, and given a title for anyone navigating by screen reader. A mobile-first app whose primary
 * navigation is five words of 10px monospace is asking a thumb to read.
 */
function TabIcon({ kind, active }: { kind: "today" | "squad" | "live" | "cash" | "you"; active: boolean }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: active ? 2.1 : 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden focusable="false">
      {kind === "today" && (<><rect x="3" y="5" width="18" height="16" rx="3" {...p} /><path d="M8 3v4M16 3v4M3 10h18" {...p} /></>)}
      {kind === "squad" && (<><circle cx="9" cy="9" r="3.2" {...p} /><path d="M3.5 19a5.7 5.7 0 0 1 11 0" {...p} /><path d="M16 7.2a3 3 0 0 1 0 5.6M17.5 19a5.6 5.6 0 0 0-2-4.1" {...p} /></>)}
      {/* Live is a broadcast, not a crosshair: a dot with signal arcs leaving it. */}
      {kind === "live" && (<><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /><path d="M7.8 7.8a5.9 5.9 0 0 0 0 8.4M16.2 16.2a5.9 5.9 0 0 0 0-8.4" {...p} /><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" {...p} opacity={active ? 0.6 : 0.45} /></>)}
      {kind === "cash" && (<><rect x="2.6" y="6" width="18.8" height="12" rx="3" {...p} /><circle cx="12" cy="12" r="2.6" {...p} /></>)}
      {kind === "you" && (<><circle cx="12" cy="8.2" r="3.6" {...p} /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" {...p} /></>)}
    </svg>
  );
}

function Section({ title }: { title: string }) { return <div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF] mt-6 mb-2">{title}</div>; }

/** Ask your own question.
 *
 * Every other app in the category decides what you are allowed to bet on. This is the one screen where
 * the room writes the question — you say it in your own words, and if the match data can prove it, a pool
 * opens on it. When it can't, it says so plainly rather than opening something it could never settle.
 */
function AskCard({ onAsk, busy, home, away }: { onAsk: (t: string) => Promise<boolean>; busy: boolean; home: string; away: string }) {
  const [text, setText] = useState("");
  const examples = [`${home} to score`, `${away} to bag a hat-trick`, `${home} to win 5+ corners`, `${away} to get booked`];
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await onAsk(t)) setText("");
  };
  return (
    <div className="mt-4 rounded-2xl border-2 border-dashed border-[var(--line)] p-4">
      <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Ask your own</div>
      <p className="text-[15px] font-bold tracking-tight mt-1">Say it how you&apos;d say it to a mate.</p>
      <div className="flex gap-2 mt-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 160))}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder={examples[0]}
          aria-label="Ask your own question about this match"
          className="flex-1 h-12 rounded-xl border border-[var(--line)] px-3.5 bg-[#FAFAF7] text-sm"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className="h-12 px-5 shrink-0 whitespace-nowrap rounded-xl bg-[var(--ink)] text-white font-bold disabled:opacity-40">
          {busy ? "Reading…" : "Open it"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2.5">
        {examples.map((e) => (
          <button key={e} onClick={() => setText(e)} className="mono text-[10px] px-2 py-1 rounded-md bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)]">
            {e}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[#9CA3AF] mt-2.5 leading-snug">
        Goals, cards, corners — anything the match data can&apos;t prove, we won&apos;t open.
      </p>
    </div>
  );
}

function CallSheet({ sheet, setSheet, stake, setStake, doStake, busy, done, shot, setShot, reason, setReason, canSeal }: any) {
  if (done) return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end">
      <div className="w-full max-w-[440px] mx-auto bg-white rounded-t-3xl p-6 pb-10 gf-pop text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-[var(--green)] flex items-center justify-center text-white text-2xl font-black mt-1">✓</div>
        <div className="text-xl font-extrabold tracking-tight mt-3">You&apos;re riding {done.amt} on {done.side === 1 ? "YES" : "NO"}</div>
        <div className="text-sm text-[var(--muted)] mt-1">{label(sheet.m).q}? · locked in</div>
        <div className="mono text-[11px] text-[var(--muted)] mt-3">Paid the second it lands — no one can void it.</div>
      </div>
    </div>
  );
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end" onClick={() => setSheet(null)}>
      <div className="w-full max-w-[440px] mx-auto bg-white rounded-t-3xl p-6 pb-9 gf-pop relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={() => setSheet(null)} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="flex items-center gap-1.5 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]"><FlagPair home={label(sheet.m).f.home} away={label(sheet.m).f.away} size={14} />{label(sheet.m).match}</div>
        <h3 className="text-2xl font-bold tracking-tight mt-1">{label(sheet.m).q}?</h3>
        <div className="flex gap-2 mt-5">{[1, 2].map((s) => (<button key={s} onClick={() => setSheet({ ...sheet, side: s })} className={`flex-1 h-12 rounded-xl font-bold ${sheet.side === s ? "bg-[var(--ink)] text-white" : "bg-white border border-[var(--ink)]"}`}>{s === 1 ? "YES" : "NO"}</button>))}</div>
        <div className="mt-5 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Stake</div>
        <div className="flex gap-2 mt-2">{[0.02, 0.05, 0.1].map((v) => (<button key={v} onClick={() => setStake(v)} className={`flex-1 h-11 rounded-xl font-semibold ${stake === v ? "border-2 border-[var(--green)] text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{v}</button>))}</div>
        {(() => {
          const p = projection(sheet.m, sheet.side, stake);
          // "% of the room" is the CURRENT pool share of your side (before your own stake), matching THE ROOM on the card.
          const yy = Number(sheet.m.yesTotal), nn = Number(sheet.m.noTotal), tot = yy + nn;
          const sharePct = tot > 0 ? Math.round(((sheet.side === 1 ? yy : nn) / tot) * 100) : 50;
          const scout = tot > 0 && sharePct > 0 && sharePct <= 35; // backing a clear minority = contrarian reward (S9)
          return (
          <>
            {scout && (
              <div className="mt-3 flex items-start gap-2 rounded-2xl bg-[var(--green)]/10 border border-[var(--green)]/30 px-3 py-2.5">
                <span className="mono text-[9px] font-extrabold tracking-widest text-white bg-[var(--green)] rounded px-1.5 py-1 mt-px shrink-0">SCOUT</span>
                <span className="text-[12px] font-semibold text-[var(--green)] leading-snug">Only {sharePct}% of the room is on this. Call it against them — the fewer who back it, the bigger your cut.</span>
              </div>
            )}
            {/* A pool that outlives its match can never prove the NO side, so NO can only ever be repaid.
                Quoting it a share of the pot would be a number we cannot pay. */}
            {(() => {
              const noPaysOut = sheet.side !== 2 || sheet.m.noResolvable !== false;
              return (
            <div className="mt-3 rounded-2xl bg-[#FAFAF7] border border-[var(--line)] p-4">
              <div className="flex justify-between mono text-[10px] text-[#9CA3AF]"><span>POOL NOW {p.potNow.toFixed(2)}</span><span>YES {p.yes.toFixed(2)} · NO {p.no.toFixed(2)}</span></div>
              <div className="mt-2 flex items-end justify-between">
                <span className="text-sm font-semibold text-[var(--muted)]">{noPaysOut ? "If it lands you win" : "If it never happens"}</span>
                <span className="text-2xl font-extrabold text-[var(--green)]">{noPaysOut ? `~${money(p.payout)}` : money(stake)}</span>
              </div>
              <div className="text-right mono text-[10px] text-[var(--muted)]">{noPaysOut ? `${p.multiple.toFixed(2)}× your stake` : "your stake back"}</div>
              {noPaysOut && p.multiple < 1.06 && <div className="mt-1 text-[11px] text-[var(--muted)]">Be first — your payout grows as others back the other side.</div>}
              {!noPaysOut && <div className="mt-1 text-[11px] text-[var(--muted)]">Nobody can win the NO side of this pool — if it never happens, you simply get your stake back.</div>}
            </div>
              );
            })()}
          </>
        ); })()}
        {/* S5 — the reason rides with the call, so a mate copying it is never copying blind. */}
        {canSeal && (
          <div className="mt-4">
            <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF] mb-1.5">Why? <span className="text-[var(--muted)] normal-case tracking-normal">· your squad sees it on the call</span></div>
            <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 120))} placeholder="Their keeper is shaky on crosses." className="w-full h-11 rounded-xl border border-[var(--line)] px-3.5 bg-[#FAFAF7] text-sm" />
          </div>
        )}
        {canSeal && (
          <div className="mt-4">
            <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF] mb-1.5">Seal a Called Shot <span className="text-[var(--muted)] normal-case tracking-normal">· opened only if you&apos;re right</span></div>
            <input value={shot} onChange={(e) => setShot(e.target.value.slice(0, 140))} placeholder="“They bottle it. Screenshot me.”" className="w-full h-11 rounded-xl border border-[var(--line)] px-3.5 bg-[#FAFAF7] text-sm" />
            {shot.trim() && <div className="mono text-[10px] text-[var(--muted)] mt-1">Sealed to your squad — torn open at full-time only if the call lands. {140 - shot.length} left.</div>}
          </div>
        )}
        <button disabled={busy === "stake"} onClick={doStake} className="mt-4 w-full h-14 rounded-2xl bg-[var(--ink)] text-white text-lg font-bold disabled:opacity-50">{busy === "stake" ? "Locking in…" : `Lock in ${stake} on ${sheet.side === 1 ? "YES" : "NO"}`}</button>
        <p className="text-center text-xs text-[#9CA3AF] mt-3">✓ Yours the moment the result&apos;s in · no house · your money back if the match is called off.</p>
      </div>
    </div>
  );
}

/** The slip.
 *
 * Two rules, learned the hard way from the category:
 *
 *  1. **A slip must never block the path to its own completion.** This sheet used to show a dead,
 *     disabled "Add 2+ calls" button over an overlay that hid the very buttons you needed. The pools you
 *     can add now live INSIDE the sheet, and when there's genuinely nothing to add we offer the one thing
 *     that does work: back the single call on its own.
 *  2. **Lead with the money, not the maths.** "4.00×" is a number for someone who already thinks in
 *     multiples. Everyone else thinks *risk this, win that*. The multiple stays, small, underneath.
 */
function SlipSheet({ slip, removeFromSlip, flipLeg, placeSlip, close, busy, candidates = [], addToSlip, backSingle, label }: any) {
  const [stake, setStake] = useState(0.05);
  const [shape, setShape] = useState<"power" | "flex">("power");

  /** S3 — the multiplier, recomputed as legs come and go. POWER multiplies each leg's pot share (one
   *  miss and it's off). FLEX is the average of the legs, because each stands alone. Both are the real
   *  parimutuel projection from the pools as they stand, never a bookmaker's price. */
  const legMult = (s: any) => {
    const yes = Number(s.market.yesTotal), no = Number(s.market.noTotal), pot = yes + no;
    const mine = s.side === 1 ? yes : no;
    if (!pot || !mine) return 2;                     // an empty side: you'd take the whole pot
    return pot / mine;
  };
  const mult = slip.length
    ? shape === "power"
      ? slip.reduce((m: number, s: any) => m * legMult(s), 1)
      : slip.reduce((m: number, s: any) => m + legMult(s), 0) / slip.length
    : 1;
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end" onClick={close}>
      <div className="w-full max-w-[440px] mx-auto bg-white rounded-t-3xl p-6 pb-9 gf-pop max-h-[88%] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={close} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="flex items-center justify-between">
          <h3 className="text-2xl font-bold tracking-tight">Your slip</h3>
          <span className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">{slip.length} call{slip.length === 1 ? "" : "s"}</span>
        </div>
        <div className="mt-4 space-y-2">
          {slip.map((s: any) => (
            <div key={s.market.pubkey} className="flex items-center gap-2 bg-[#FAFAF7] border border-[var(--line)] rounded-xl p-3">
              <button onClick={() => flipLeg(s.market.pubkey)} aria-label="Flip this call"
                className={`mono text-[9px] font-extrabold tracking-widest rounded px-1.5 py-1 shrink-0 ${s.side === 1 ? "bg-[var(--green)] text-white" : "bg-[var(--ink)] text-white"}`}>
                {s.side === 1 ? "YES" : "NO"}
              </button>
              <span className="flex-1 text-sm font-semibold truncate">{s.q}?</span>
              <span className="mono text-[10px] text-[var(--muted)] tabular-nums">{legMult(s).toFixed(2)}×</span>
              <button onClick={() => removeFromSlip(s.market.pubkey)} aria-label={`Remove ${s.q}`}
                className="shrink-0 w-8 h-8 rounded-lg border border-[var(--line)] bg-white text-[var(--muted)] flex items-center justify-center active:scale-95 transition-transform">✕</button>
            </div>
          ))}
        </div>

        {/* The way out of a one-call slip, in the sheet — never behind it. */}
        {slip.length < 2 && (
          <div className="mt-4 rounded-2xl border-2 border-dashed border-[var(--line)] p-3">
            <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF] px-1">
              {candidates.length ? "Add one more to place a slip" : "Nothing else open on this match"}
            </div>
            {candidates.length > 0 ? (
              <div className="mt-2 space-y-2">
                {candidates.slice(0, 4).map((m: MarketView) => (
                  <div key={m.pubkey} className="flex items-center gap-2">
                    <span className="flex-1 text-[13px] font-semibold truncate">{label(m).q}?</span>
                    <button onClick={() => addToSlip(m, 1)} className="mono text-[10px] font-extrabold tracking-widest rounded px-2.5 py-1.5 bg-[var(--green)] text-white active:scale-95 transition-transform">YES</button>
                    <button onClick={() => addToSlip(m, 2)} className="mono text-[10px] font-extrabold tracking-widest rounded px-2.5 py-1.5 bg-[var(--ink)] text-white active:scale-95 transition-transform">NO</button>
                  </div>
                ))}
              </div>
            ) : (
              <button onClick={() => backSingle(slip[0].market, slip[0].side)} className="mt-2 w-full h-12 rounded-xl bg-[var(--ink)] text-white font-bold">
                Back this one on its own →
              </button>
            )}
          </div>
        )}
        {slip.length >= 2 && (
        <div className="mt-4 flex gap-2">
          {(["power", "flex"] as const).map((k) => (
            <button key={k} onClick={() => setShape(k)}
              className={`flex-1 py-2.5 rounded-xl font-bold text-sm ${shape === k ? "bg-[var(--ink)] text-white" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>
              {k === "power" ? "Power" : "Flex"}
            </button>
          ))}
        </div>
        )}
        {slip.length >= 2 && <>
        <div className="mt-4 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Stake</div>
        <div className="flex gap-2 mt-2">{[0.02, 0.05, 0.1].map((v) => (<button key={v} onClick={() => setStake(v)} className={`flex-1 h-11 rounded-xl font-semibold ${stake === v ? "border-2 border-[var(--green)] text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{v}</button>))}</div>

        {/* Risk this → win that. The multiple is the footnote, not the headline. */}
        <div className="mt-3 rounded-2xl bg-[var(--ink)] text-white p-4">
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--greenb)]">{shape === "power" ? "If they ALL land" : "Each call pays alone"}</div>
          <div className="mt-1.5 flex items-end justify-between gap-3">
            <div className="text-[15px] font-semibold text-white/70 leading-tight">Risk {fmtAmt(stake)}<br />to win</div>
            <div className="text-right">
              <div className="text-[34px] leading-none font-black tabular-nums text-[var(--greenb)] transition-all duration-300">≈{money(stake * mult)}</div>
              <div className="mono text-[10px] text-white/40 mt-1 tabular-nums">{mult.toFixed(2)}× your stake · est.</div>
            </div>
          </div>
          <div className="text-[12px] text-white/70 mt-2.5 leading-snug">
            {shape === "power"
              ? `Estimated: you split the whole pot with everyone who also backed all ${slip.length} to land, so it grows every time someone bets the slip busts. One miss and the slip is off.`
              : `Estimated: your stake is split across the ${slip.length} calls. Each settles on its own result, so a miss costs you that call and nothing else.`}
          </div>
        </div>

        <button disabled={busy === "slip"} onClick={() => placeSlip(stake, shape)} className="mt-4 w-full h-14 rounded-2xl bg-[var(--green)] text-white text-lg font-bold disabled:opacity-50">{busy === "slip" ? "Placing…" : `Place ${shape === "power" ? "Power" : "Flex"} slip · ${stake}`}</button>
        <p className="text-center text-xs text-[#9CA3AF] mt-3">{shape === "power" ? "All calls in one match · collect the moment the last one lands." : "All calls in one match · each collects the moment it lands."}</p>
        </>}
      </div>
    </div>
  );
}

function PoolDetail({ m, close, setSheet, settle, claim, busy, kernel, cfg, flash }: any) {
  const rake = cfg?.rakeBps ?? 0;
  // The booking-code loop (SportyBet's growth engine): this exact pool as a link for the group chat.
  const sharePool = async () => {
    const url = `${window.location.origin}/?pool=${m.pubkey}`;
    const text = `${label(m).q}? — call it with me on GAFFER 🟢 ${url}`;
    try {
      if ((navigator as any).share) await (navigator as any).share({ text });
      else { await navigator.clipboard.writeText(text); flash?.("Call copied — paste it in the chat"); }
    } catch { /* dismissed */ }
  };
  const l = label(m); const yes = Number(m.yesTotal) / 1e9; const no = Number(m.noTotal) / 1e9; const pot = yes + no;
  const [posY, setPosY] = useState<any>(null);
  const [posN, setPosN] = useState<any>(null);
  useEffect(() => { if (kernel) { kernel.myPosition(m.pubkey, 1).then(setPosY); kernel.myPosition(m.pubkey, 2).then(setPosN); } }, [kernel, m.pubkey]);
  const mine = [posY?.amount > 0 ? { side: "YES", ...posY } : null, posN?.amount > 0 ? { side: "NO", ...posN } : null].filter(Boolean) as any[];
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end" onClick={close}>
      <div className="w-full max-w-[440px] mx-auto bg-white rounded-t-3xl p-6 pb-9 gf-pop max-h-[88%] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={close} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="flex items-center gap-1.5 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]"><FlagPair home={l.f.home} away={l.f.away} size={14} />{l.match} · {m.statusLabel}</div>
        <h3 className="text-2xl font-bold tracking-tight mt-1">{l.q}?</h3>
        <div className="mt-4 bg-[var(--ink)] rounded-2xl p-5 text-white">
          <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">In the pot</div>
          <div className="text-4xl font-extrabold mt-1">{pot.toFixed(2)} <span className="text-lg font-bold text-[#9CA3AF]">{COIN}</span></div>
          <div className="text-[12px] text-[#9CA3AF] mt-2">The whole pot splits between everyone who calls it right — no house, no cut.</div>
          <div className="flex gap-4 mt-3 text-sm"><span className="text-[var(--greenb)]">YES {fmtAmt(yes)}</span><span className="text-[#9CA3AF]">NO {fmtAmt(no)}</span></div>
        </div>
        {/* The fee line — printed straight from the on-chain rake. 0 today; the whole pot is yours to split. */}
        <div className="mt-2 flex items-center justify-between rounded-xl bg-[#FAFAF7] border border-[var(--line)] px-3 py-2">
          <span className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">House cut</span>
          <span className="text-[13px] font-bold text-[var(--green)]">{rake === 0 ? "0% — no cut" : `${(rake / 100).toFixed(2)}%`}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          {[1, 2].map((s) => { const mm = sideMultiple(m, s); return (
            <div key={s} className="rounded-xl border border-[var(--line)] p-3 text-center">
              <div className="mono text-[10px] text-[#9CA3AF]">{s === 1 ? "YES" : "NO"} pays now</div>
              <div className="text-xl font-extrabold">{mm ? mm.toFixed(2) + "×" : "be first"}</div>
            </div>
          ); })}
        </div>
        {mine.map((p) => (<div key={p.side} className="mt-3 text-sm text-[var(--muted)]">Your call: <b className="text-[var(--ink)]">{money(p.amount)}</b> on {p.side}{p.claimed ? " · collected" : ""}</div>))}
        {m.status === 0 ? (
          <>
            <div className="flex gap-2 mt-5"><button onClick={() => { close(); setSheet({ m, side: 1 }); }} className="flex-1 h-12 rounded-xl bg-[var(--ink)] text-white font-bold">Back YES</button><button onClick={() => { close(); setSheet({ m, side: 2 }); }} className="flex-1 h-12 rounded-xl bg-white border border-[var(--ink)] font-bold">Back NO</button></div>
            <button onClick={sharePool} className="mt-2 w-full h-10 rounded-xl border border-dashed border-[var(--line)] text-[var(--muted)] text-[13px] font-semibold">Send this call to the chat</button>
            {DEV && <button disabled={!!busy} onClick={() => settle(m)} className="mt-2 w-full h-10 rounded-lg bg-[#FAFAF7] border border-[var(--line)] mono text-[11px] text-[var(--muted)]">check &amp; pay out →</button>}
          </>
        ) : mine.length > 0 ? (
          <button disabled={!!busy} onClick={() => claim(m)} className="mt-5 w-full h-12 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{m.status === 2 ? "Get your money back →" : "Collect your winnings →"}</button>
        ) : (
          <div className="mt-5 text-sm text-[var(--muted)] text-center py-2">{m.status === 2 ? "This one was called off — stakes went back to everyone." : "This one's settled. You weren't in it."}</div>
        )}
        <details className="mt-5"><summary className="mono text-[11px] text-[var(--muted)] cursor-pointer">Why does it pay like this?</summary><p className="text-[13px] text-[var(--muted)] mt-2 leading-relaxed">Everyone backing the right side splits the whole pot in proportion to their stake. There&apos;s no bookie taking a cut and no one who can refuse to pay you — the moment the result&apos;s in, it&apos;s yours to collect.</p></details>
      </div>
    </div>
  );
}

/** Ambient mode (L4) — a dark, zero-interaction, glanceable full-screen view of the match you care
 * about: big teams, the Drama band, your calls riding. This is what a fan props the phone on during a
 * match. Tap anywhere to exit. (The PWA's stand-in for a Live Activity.) */
function AmbientView({ fixtureId, positions = [], onClose }: any) {
  const f = fx(fixtureId);
  const [o, setO] = useState<any>(null);
  useEffect(() => { let live = true; fetch(`/api/odds/${fixtureId}`).then((r) => r.json()).then((d) => { if (live) setO(d); }).catch(() => {}); return () => { live = false; }; }, [fixtureId]);
  const riding = positions.filter((p: any) => !p.claimed && p.amount > 0).length;
  const gap = o?.hasOdds ? Math.abs((o.home || 0) - (o.away || 0)) : null;
  const band = gap == null ? null : gap <= 8 ? "GOING TO THE WIRE" : gap <= 18 ? "WOBBLING" : gap <= 30 ? "IN THE BALANCE" : "CRUISING";
  return (
    <div onClick={onClose} className="fixed inset-0 z-[55] flex flex-col items-center justify-center text-white px-8 text-center" style={{ background: "radial-gradient(120% 90% at 50% 30%, #0b3b2a, #05100b)" }}>
      <div className="mono text-[10px] tracking-[0.3em] uppercase text-white/40">Ambient · tap to exit</div>
      <div className="flex items-center gap-3 mt-8"><Flag name={f.home} size={30} round /><span className="text-3xl font-extrabold tracking-tight">{f.home}</span></div>
      <div className="mono text-sm text-white/35 my-2.5">v</div>
      <div className="flex items-center gap-3"><Flag name={f.away} size={30} round /><span className="text-3xl font-extrabold tracking-tight">{f.away}</span></div>
      {band && <div className="mono text-[11px] tracking-[0.2em] uppercase text-[var(--greenb)] mt-10">{band}</div>}
      <div className="mono text-[11px] text-white/50 mt-3">{riding} call{riding === 1 ? "" : "s"} riding</div>
    </div>
  );
}

/** C1 — the match-timeline strip: the moment you called it, drawn to the moment it paid. A dot where
 * the call went in, a gold flare where the money landed. No fabricated minutes — if we don't know when
 * the call was made relative to full-time, the strip simply doesn't draw. */
function TimelineStrip({ calledPct }: { calledPct: number | null }) {
  if (calledPct == null) return null;
  const x = Math.min(92, Math.max(6, calledPct));
  return (
    <div className="mt-3">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-[#EDEDE8]" />
        <div className="absolute top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-[var(--green)]" style={{ left: `${x}%`, right: 0 }} />
        <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-[var(--ink)] ring-2 ring-white" style={{ left: `calc(${x}% - 5px)` }} />
        <div className="absolute top-1/2 -translate-y-1/2 right-0 w-4 h-4 rounded-full bg-[#D8A32B] ring-2 ring-white" style={{ boxShadow: "0 0 10px rgba(216,163,43,0.7)" }} />
      </div>
      <div className="flex justify-between mono text-[9px] uppercase tracking-widest text-[#9CA3AF]">
        <span>called it</span><span>paid</span>
      </div>
    </div>
  );
}

/** "settled 43s after full-time" — only ever printed for a genuinely live settlement. */
function settledAfterLabel(ms: number | null | undefined): string | null {
  if (ms == null || ms < 0 || ms >= 3_600_000) return null;  // a replayed fixture settles days later; don't brag
  const s = Math.round(ms / 1000);
  return s < 90 ? `settled ${s}s after full-time` : `settled ${Math.round(s / 60)} min after full-time`;
}

function PaidOverlay({ paid, close, flash, econ }: any) {
  const contrarian = paid.calledAt != null && paid.calledAt <= 40;
  // Choreography (C2): a brief hush, a haptic "land" + the opt-in chime, then the number counts up
  // from zero — we celebrate the OUTCOME (being right), never the stake.
  const [amt, setAmt] = useState(0);
  useEffect(() => {
    hapticPaid();
    playPaid();                                   // silent unless the fan turned Stadium sound on
    const t = setTimeout(() => setAmt(paid.amount), 260);
    return () => clearTimeout(t);
  }, [paid.amount]);

  const stake = Number(paid.staked) || 0;
  const settled = settledAfterLabel(paid.settledAfterMs);
  const rec = econ?.foresight;
  const record = rec && rec.wins + rec.losses > 0 ? `${rec.wins}–${rec.losses} this Cup` : null;

  const share = async () => {
    // N3 — the card speaks the reader's language. Mexico is half this market.
    const lang = detectLang();
    const text = shareWin(lang, {
      stake: stake > 0 ? stake : undefined,
      payout: paid.amount,
      question: paid.q,
      calledAt: paid.calledAt ?? null,
      mult: paid.mult ?? null,
      settled: settled ? settled.replace(/^settled /, "") : null,
      record: rec && rec.wins + rec.losses > 0 ? { w: rec.wins, l: rec.losses } : null,
      url: "gaffer-cyan.vercel.app",
    });
    try {
      if ((navigator as any).share) await (navigator as any).share({ text });
      else { await navigator.clipboard.writeText(text); flash?.("Receipt copied — paste it in the chat"); }
    } catch { /* dismissed */ }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center text-white px-7" style={{ background: "radial-gradient(120% 90% at 50% 30%, #047857, #064e3b)" }}>
      <div className="absolute top-[18%] w-52 h-52 rounded-full border-2 border-white/30 gf-ring" />
      {/* Proof-of-Payout v2 */}
      <div className="relative gf-pop w-full max-w-xs bg-white text-[var(--ink)] rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Receipt</span>
          <span className="text-[9px] font-bold text-white bg-[var(--green)] rounded-full px-2 py-0.5">✓ VERIFIED</span>
        </div>

        {/* The hero pair: what you put in, what came out. The format that travels. */}
        {stake > 0 ? (
          <div className="mt-4 flex items-baseline justify-center gap-2.5">
            <span className="text-2xl font-bold text-[var(--muted)] tabular-nums">{money(stake)}</span>
            <span className="text-xl text-[#9CA3AF]">→</span>
            <span className="text-[44px] leading-none font-extrabold tracking-tight text-[var(--green)] tabular-nums"><TickNum value={amt} /></span>
          </div>
        ) : (
          <div className="text-[54px] font-extrabold tracking-tight leading-none mt-4 text-center text-[var(--green)]">+<TickNum value={amt} /></div>
        )}
        <div className="text-center text-[var(--muted)] text-sm mt-1">{COIN} · it&apos;s yours</div>
        <div className="mono text-[10px] tracking-[0.25em] uppercase text-[var(--muted)] mt-3 text-center">You called it</div>
        <div className="text-center text-base font-bold mt-1">{paid.q}</div>

        <TimelineStrip calledPct={paid.calledAt != null ? paid.calledAt : null} />

        {/* The odds-stamp: the crowd's belief in your side the instant you locked. Low = you saw it first. */}
        {paid.calledAt != null && (
          <div className={`mt-2 rounded-xl px-3 py-2 text-[12px] font-bold text-center ${contrarian ? "bg-[var(--green)]/10 text-[var(--green)]" : "bg-[#FAFAF7] text-[var(--muted)] border border-[var(--line)]"}`}>
            {/* Two lines, each whole. Three phrases on one row wrapped into ragged thirds on a phone. */}
            <div className="flex items-center justify-center gap-2 whitespace-nowrap">
              <span>Called at {paid.calledAt}%</span>
              {paid.mult ? <><span className="opacity-40">·</span><span>paid {paid.mult.toFixed(2)}×</span></> : null}
            </div>
            {contrarian && <div className="mt-0.5 whitespace-nowrap">you saw it first</div>}
          </div>
        )}

        {(settled || record) && (
          <div className="mt-2 flex items-center justify-center gap-2 mono text-[10px] text-[#9CA3AF]">
            {settled ? <span>{settled}</span> : null}
            {settled && record ? <span className="opacity-40">·</span> : null}
            {record ? <span className="font-bold text-[var(--ink)]">{record}</span> : null}
          </div>
        )}

        <div className="mt-3 rounded-xl bg-[#FAFAF7] border border-[var(--line)] p-2.5 text-center text-[12px] font-semibold">It&apos;s yours. No one can take it back.</div>
        {paid.sig && <a href={EXPLORER(paid.sig)} target="_blank" rel="noreferrer" className="block text-center mono text-[10px] text-[#9CA3AF] mt-3 underline">see the receipt ›</a>}
      </div>
      <div className="relative mt-6 w-full max-w-xs flex gap-2">
        <button onClick={share} className="flex-1 py-3.5 rounded-2xl bg-white/15 text-white font-bold">Share</button>
        <button onClick={close} className="flex-1 py-3.5 rounded-2xl bg-white text-[#047857] font-bold">Done</button>
      </div>
    </div>
  );
}

/** K6 — Add to Home Screen. On iOS there is no prompt event, so we say how rather than showing a button
 * that cannot work. Once installed the card disappears entirely — it has nothing left to say. */
function InstallCard() {
  const [can, setCan] = useState(false);
  const [installed, setInstalled] = useState(false);
  useEffect(() => { setInstalled(isStandalone()); return onInstallable(setCan); }, []);
  if (installed) return null;

  if (isIOS()) return (
    <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="font-bold text-[15px]">Add GAFFER to your home screen</div>
      <div className="text-[12px] text-[var(--muted)] mt-0.5">Tap Share, then “Add to Home Screen”. Alerts only work once it&apos;s installed.</div>
    </div>
  );
  if (!can) return null;
  return (
    <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between gap-3">
      <div><div className="font-bold text-[15px]">Add to home screen</div><div className="text-[12px] text-[var(--muted)] mt-0.5">Opens like an app, and alerts start working.</div></div>
      <button onClick={() => promptInstall()} className="px-3 h-10 rounded-xl bg-[var(--ink)] text-white text-sm font-bold shrink-0">Add</button>
    </div>
  );
}

/** Q1 — the side you took, worn beside your name. Twitch's lesson: a visible side is what lets the room
 * call each other out, and it's what turns a prediction into an inside joke. */
function SideBadge({ side }: { side: number | undefined }) {
  if (side !== 1 && side !== 2) return null;
  const yes = side === 1;
  return (
    <span className={`mono text-[9px] font-extrabold tracking-widest rounded px-1.5 py-0.5 shrink-0 ${yes ? "bg-[var(--green)] text-white" : "bg-[var(--ink)] text-white"}`}>
      {yes ? "YES" : "NO"}
    </span>
  );
}

/** Q9 — the commissioner's controls. The organizer is the real customer: the person who drags fourteen
 * mates in and then has to run the thing. Give them the four controls every pool thread begs for —
 * remove someone, call on behalf of a member who can't, hide picks until lock, and pin the stakes. */
function CommissionerPanel({ settings, members, userId, onCommish }: any) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string>(settings.prizeNote || "");
  // `members` is a map keyed by user id, not an array.
  const others = Object.values(members || {}).filter((m: any) => m.id !== userId);
  const afterLock = settings.picksVisible === "after_lock";

  return (
    <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">You run this squad</span>
        <span className="mono text-[10px] font-bold text-[var(--green)]">{open ? "close" : "manage"}</span>
      </button>

      {settings.prizeNote && !open && <div className="mt-1 text-sm font-bold">Playing for: {settings.prizeNote}</div>}

      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF] mb-1.5">What are you playing for?</div>
            <div className="flex gap-2">
              <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 140))} placeholder="Loser buys the curry."
                className="flex-1 h-10 rounded-xl border border-[var(--line)] px-3 bg-[#FAFAF7] text-sm" />
              <button onClick={() => onCommish("prize", { note })} className="px-3 h-10 rounded-xl bg-[var(--ink)] text-white text-sm font-bold">Pin</button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="pr-3">
              <div className="font-bold text-[14px]">Hide picks until lock</div>
              <div className="text-[12px] text-[var(--muted)]">Nobody can copy a call before the cut-off.</div>
            </div>
            <button onClick={() => onCommish("visibility", { mode: afterLock ? "always" : "after_lock" })}
              aria-label="Toggle pick visibility"
              className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${afterLock ? "bg-[var(--green)]" : "bg-[var(--line)]"}`}>
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${afterLock ? "left-6" : "left-1"}`} />
            </button>
          </div>

          {others.length > 0 && (
            <div>
              <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF] mb-1.5">Members</div>
              <div className="space-y-1.5">
                {others.map((m: any) => {
                  const id = m.id;
                  return (
                    <div key={id} className="flex items-center gap-2">
                      <span className="flex-1 text-sm font-semibold truncate">{m.name}</span>
                      <button onClick={() => onCommish("proxy", { targetId: id, allow: !m.proxyOk })}
                        className={`mono text-[10px] font-bold px-2 py-1.5 rounded-lg border ${m.proxyOk ? "border-[var(--green)] text-[var(--green)]" : "border-[var(--line)] text-[var(--muted)]"}`}>
                        {m.proxyOk ? "PROXY ON" : "PROXY"}
                      </button>
                      <button onClick={() => onCommish("kick", { targetId: id })}
                        className="mono text-[10px] font-bold px-2 py-1.5 rounded-lg border border-[var(--line)] text-[var(--muted)]">REMOVE</button>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-[var(--muted)] mt-2 leading-snug">Proxy lets you make a call for someone who can&apos;t — a grandparent, a mate with no phone.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Squad({ userId, userName, setName, nation, setNation, squadCode, squadData, createMySquad, joinByCode, postBanter, reactTo, copyCall, leaveSquad, pendingJoin, flash, duels = [], squadSettings, lore = [], onFade, onCommish, joinTribe }: any) {
  const [view, setView] = useState<"squad" | "nations">("squad");
  const [sqName, setSqName] = useState("");
  const [code, setCode] = useState(pendingJoin || "");
  const [handle, setHandle] = useState(userName === "You" ? "" : userName);
  const [msg, setMsg] = useState("");
  const [nations, setNations] = useState<{ name: string; pts: number; fans: number }[]>([]);
  // The Adoption (N2): a second nation you back — worn as an origin chip. 66% of fans root for 2+ teams.
  const [adopted, setAdopted] = useState<string>(() => (typeof window !== "undefined" ? localStorage.getItem("gaffer_adopted") || "" : ""));
  // Fade Duels (S6) now live on the SERVER — the person you fade sees the same duel, and it settles off
  // the pool's real result. `duels`, `settings` and `lore` arrive as props from the squad fetch.
  const fadeDuel = (f: any) => onFade?.(f);
  const adopt = (n: string) => { const v = n === adopted ? "" : n; setAdopted(v); if (typeof window !== "undefined") localStorage.setItem("gaffer_adopted", v); flash(v ? `Adopted ${v} — worn to the final` : "Dropped your second nation"); };
  useEffect(() => { if (pendingJoin) setCode(pendingJoin); }, [pendingJoin]);
  useEffect(() => { if (view === "nations") getNations().then(setNations); }, [view]);

  const toggle = (
    <div className="flex gap-2 mt-1">
      {(["squad", "nations"] as const).map((v) => (<button key={v} onClick={() => setView(v)} className={`flex-1 h-10 rounded-xl font-bold text-sm ${view === v ? "bg-[var(--ink)] text-white" : "bg-white border border-[var(--line)]"}`}>{v === "squad" ? (squadData?.name || "Squad") : "Nations"}</button>))}
    </div>
  );
  const Nations = (
    <>
      <TheWake nation={nation} />
      <Section title={`Fly your flag · you fly ${nation}`} />
      <div className="flex flex-wrap gap-2">
        {PICK_NATIONS.map((n) => (
          <button key={n.name} onClick={() => { setNation(n.name); flash(`Now flying ${n.name}`); getNations().then(setNations); }} className={`h-10 px-3 rounded-xl border text-sm font-semibold flex items-center gap-1.5 ${n.name === nation ? "border-[var(--green)] bg-[var(--green)]/10" : "border-[var(--line)] bg-white"}`}><Flag name={n.name} size={16} round />{n.name}</button>
        ))}
      </div>
      <Section title="Adopt a second nation" />
      <p className="text-[12px] text-[var(--muted)] -mt-1 mb-2">Your team out, or just love an underdog? Back a second — worn as an origin chip to the final.</p>
      {adopted ? (
        <div className="flex items-center gap-3 rounded-2xl bg-[var(--green)]/10 border border-[var(--green)]/25 p-3.5">
          <div className="flex items-center gap-1"><Flag name={nation} size={20} round /><span className="text-[var(--muted)]">→</span><Flag name={adopted} size={20} round /></div>
          <span className="flex-1 text-sm font-semibold">{nation} <span className="text-[var(--muted)] font-normal">then</span> {adopted}</span>
          <button onClick={() => adopt(adopted)} className="mono text-[10px] text-[var(--muted)] underline">drop</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {PICK_NATIONS.filter((n) => n.name !== nation).slice(0, 8).map((n) => (
            <button key={n.name} onClick={() => adopt(n.name)} className="h-9 px-3 rounded-xl border border-[var(--line)] bg-white text-sm font-semibold flex items-center gap-1.5"><Flag name={n.name} size={14} round />{n.name}</button>
          ))}
        </div>
      )}

      <Section title="Nation board · live" />
      {nations.length === 0 ? (
        <div className="bg-white border border-[var(--line)] rounded-2xl p-5 text-sm text-[var(--muted)] text-center">Standings build as fans earn points. You&apos;re first in — pick your flag above.</div>
      ) : (
        <div className="bg-white border border-[var(--line)] rounded-2xl overflow-hidden">
          {nations.map((n, i) => (<div key={n.name} className={`w-full flex items-center gap-3 px-4 py-3 border-b border-[#F1F1EF] text-left ${n.name === nation ? "bg-[#FAFAF7]" : ""}`}><span className="mono text-xs w-4 text-[var(--muted)]">{i + 1}</span><Flag name={n.name} size={22} round /><span className={`flex-1 ${n.name === nation ? "font-bold" : "font-medium"}`}>{n.name}{n.name === nation ? " · you" : ""}</span><span className="mono text-[10px] text-[var(--muted)] mr-2">{n.fans} fan{n.fans === 1 ? "" : "s"}</span><span className="mono text-sm">{n.pts}</span></div>))}
        </div>
      )}
      <p className="text-[12px] text-[var(--muted)] mt-3">Every fan&apos;s points stack up by country. Change your flag in Squad settings.</p>
    </>
  );

  if (view === "nations") return <div>{toggle}{Nations}</div>;

  // Not in a squad → create / join
  if (!squadCode || !squadData) {
    return (
      <div>
        {toggle}
        <div className="bg-[var(--ink)] rounded-3xl p-6 text-white mt-2">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Your squad</div>
          <div className="text-xl font-bold mt-2">Bring the group chat. Call it together, talk all tournament.</div>
        </div>
        <Section title="Your name" />
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="What should the squad call you?" className="w-full h-12 rounded-xl border border-[var(--line)] px-4 bg-white" />
        {/* Q6 — nobody should hit a dead end because their mates haven't joined yet. */}
        <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">No mates on it yet?</div>
          <div className="text-sm font-bold mt-0.5">Join the {nation} tribe.</div>
          <p className="text-[12px] opacity-75 mt-0.5">A public room of {nation} fans. Same banter, same windows, already full of people.</p>
          <button onClick={joinTribe} className="mt-3 w-full py-2.5 rounded-xl bg-white text-[var(--ink)] font-bold text-sm">Take me there</button>
        </div>

        <Section title="Start a squad" />
        <input value={sqName} onChange={(e) => setSqName(e.target.value)} placeholder="Squad name (e.g. The Camden Lot)" className="w-full h-12 rounded-xl border border-[var(--line)] px-4 bg-white" />
        <button disabled={!sqName.trim() || !handle.trim()} onClick={() => createMySquad(sqName.trim(), handle.trim())} className="mt-2 w-full h-12 rounded-xl bg-[var(--ink)] text-white font-bold disabled:opacity-40">Create squad</button>
        <Section title="Or join with a code" />
        <div className="flex gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" className="flex-1 h-12 rounded-xl border border-[var(--line)] px-4 mono tracking-widest uppercase bg-white" />
          <button disabled={code.trim().length < 4 || !handle.trim()} onClick={() => joinByCode(code.trim(), handle.trim())} className="px-5 h-12 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-40">Join</button>
        </div>
        {pendingJoin && <p className="text-[12px] text-[var(--green)] mt-2">You were invited to squad <b>{pendingJoin}</b> — add your name and tap Join.</p>}
      </div>
    );
  }

  const sq = squadData;
  const members: any[] = Object.values(sq.members).sort((a: any, b: any) => b.points - a.points);
  const me: any = members.find((m) => m.id === userId);
  const myRank = members.findIndex((m) => m.id === userId) + 1;
  const BADGE = 250, earned = (me?.points || 0) >= BADGE; // an honest milestone, not a fake rival
  const link = typeof window !== "undefined" ? `${window.location.origin}/?squad=${sq.code}` : "";
  const REACTS = ["🔥", "👏", "🤣", "🐐"]; // banter reactions — the ONE place emoji is allowed (server-side whitelist)
  const share = async () => { const text = `Join my GAFFER squad "${sq.name}" 🟢 ${link}`; try { if ((navigator as any).share) await (navigator as any).share({ text }); else { await navigator.clipboard.writeText(link); flash("Invite link copied"); } } catch { /* dismissed */ } };

  return (
    <div>
      {toggle}
      {/* shareable standings card (screenshot it into the chat) */}
      <div className="mt-2 rounded-3xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0e0e0f,#10261d)" }}>
        <div className="flex items-center justify-between"><span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{sq.name} · matchday</span><span className="mono text-[10px] text-[#9CA3AF]">{members.length} in</span></div>
        <div className="mt-3 space-y-1.5">
          {members.slice(0, 3).map((m, i) => (<div key={m.id} className="flex items-center gap-2"><span className="w-5 flex justify-center"><RankBadge i={i} onDark /></span><span className={`flex-1 ${m.id === userId ? "font-extrabold text-[var(--greenb)]" : "font-semibold"}`}>{m.name}</span><span className="mono text-sm">{m.points}</span></div>))}
        </div>
        {myRank > 3 && <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2"><span className="w-5 text-center">{myRank}</span><span className="flex-1 font-extrabold text-[var(--greenb)]">{me?.name || "You"}</span><span className="mono text-sm">{me?.points || 0}</span></div>}
        <div className="mt-3 mono text-[9px] text-[#6B7280]">gaffer · call it, get paid</div>
      </div>
      <div className="flex gap-2 mt-2">
        <button onClick={share} className="flex-1 h-11 rounded-xl bg-[var(--ink)] text-white font-bold text-sm">Share / invite</button>
        <button onClick={() => { navigator.clipboard.writeText(sq.code); flash(`Code ${sq.code} copied`); }} className="px-4 h-11 rounded-xl bg-white border border-[var(--line)] mono font-bold text-sm">{sq.code}</button>
      </div>

      <div className={`mt-3 rounded-xl p-3 text-sm font-semibold ${earned ? "bg-[var(--green)]/10 text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{earned ? "Skipper badge earned — 250 pts and climbing." : `${BADGE - (me?.points || 0)} pts to the Skipper badge (you: ${me?.points || 0})`}</div>
      {members.length < 6 && <p className="mono text-[11px] text-[var(--muted)] mt-2">{members.length}/15 · best squads are 6–15 — invite a few more for live banter.</p>}

      <Section title="Leaderboard · live" />
      <div className="bg-white border border-[var(--line)] rounded-2xl overflow-hidden">
        {members.map((m, i) => (<div key={m.id} className={`flex items-center gap-3 px-4 py-3 border-b border-[#F1F1EF] ${m.id === userId ? "bg-[#FAFAF7]" : ""}`}><span className="w-5 flex justify-center"><RankBadge i={i} /></span><span className={`w-7 h-7 rounded-full ${m.id === userId ? "bg-[var(--ink)]" : "bg-[var(--green)]"} text-white text-[11px] font-bold flex items-center justify-center`}>{(m.name[0] || "?").toUpperCase()}</span><span className={`flex-1 ${m.id === userId ? "font-bold" : "font-medium"}`}>{m.name}{m.id === userId ? " (you)" : ""}</span>{m.streak > 0 && <span className="mono text-[10px] text-[var(--muted)]">{m.streak}d run</span>}<span className="mono text-sm font-semibold">{m.points}</span></div>))}
      </div>

      {/* The lore wall (Q2) — the squad's canonized moments pinned above the chatter: sealed Called Shots
          waiting for full-time, and the ones that got torn open. Communities remember their own history. */}
      {(() => {
        const shots = sq.feed.filter((f: any) => f.kind === "shot");
        const sealed = shots.filter((f: any) => !f.revealed).length;
        const opened = shots.filter((f: any) => f.revealed && f.shotWin);
        if (shots.length === 0) return null;
        return (
          <div className="mt-6 rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#0e0e0f,#171226)" }}>
            <div className="mono text-[10px] tracking-widest uppercase text-white/50">Squad lore</div>
            {sealed > 0 && <div className="text-white text-[14px] font-semibold mt-1.5">{sealed} Called Shot{sealed === 1 ? "" : "s"} sealed — torn open at full-time.</div>}
            {opened.slice(-2).map((f: any) => (<div key={f.id} className="text-[13px] text-[var(--greenb)] mt-1.5">“{f.sealed}” — {f.name} called it.</div>))}
          </div>
        );
      })()}

      {/* Q7 — draft night. The dark days between rounds are dead air this product can own. */}
      {squadCode && (
        <RoundTable
          code={squadCode}
          userId={userId}
          token={typeof window !== "undefined" ? localStorage.getItem("gaffer_squad_token") || "" : ""}
          isOwner={squadSettings?.ownerId === userId}
          flash={flash}
        />
      )}

      {/* Q2 — the lore wall: moments auto-named from what actually happened, pinned forever. */}
      {lore.length > 0 && (
        <>
          <Section title="The wall" />
          <div className="space-y-1.5">
            {lore.slice(0, 5).map((l: any, i: number) => (
              <div key={i} className="bg-white border border-[var(--line)] rounded-xl px-3.5 py-2.5">
                <div className="text-sm font-black">{l.title}</div>
                <div className="text-[12px] text-[var(--muted)] mt-0.5">{l.detail}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* S6 — duels, with the standing head-to-head. Settled off the pool, so the record is true. */}
      {duels.length > 0 && (
        <>
          <Section title="Your duels" />
          <div className="space-y-1.5">
            {duels.map((d: any) => {
              const lead = d.record.mine > d.record.theirs ? "You lead" : d.record.mine < d.record.theirs ? `${d.them.name} leads` : "All square";
              const score = `${Math.max(d.record.mine, d.record.theirs)}–${Math.min(d.record.mine, d.record.theirs)}`;
              const won = d.status === "settled" && d.winner === d.me.userId;
              const lost = d.status === "settled" && d.winner === d.them.userId;
              return (
                <div key={d.id} className="bg-white border border-[var(--line)] rounded-xl px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="mono text-[9px] font-bold tracking-widest text-white bg-[var(--ink)] rounded px-1.5 py-1">H2H</span>
                    <span className="flex-1 text-sm font-semibold truncate">You vs {d.them.name}</span>
                    {d.status === "settled" ? (
                      <span className={`mono text-[9px] font-extrabold tracking-widest rounded px-2 py-1 ${won ? "bg-[var(--green)] text-white" : "bg-[#FAFAF7] text-[var(--muted)] border border-[var(--line)]"}`}>
                        {won ? "WON" : lost ? "LOST" : "VOID"}
                      </span>
                    ) : (
                      <span className="mono text-[9px] font-extrabold tracking-widest rounded px-2 py-1 bg-[#D8A32B] text-white">LIVE</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[var(--muted)] mt-1 truncate">{d.question}</div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="mono text-[10px] text-[var(--muted)]">{score === "0–0" ? "First blood" : `${lead} ${score}`}</span>
                    {d.status === "settled" && (
                      <button onClick={() => copyCall(d.market, d.me.side)} className="mono text-[10px] font-bold text-[var(--green)]">REMATCH →</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Q9 — the commissioner's controls. Only the owner sees them; the server re-checks regardless. */}
      {squadSettings && squadSettings.ownerId === userId && (
        <CommissionerPanel settings={squadSettings} members={squadData?.members || []} userId={userId} onCommish={onCommish} />
      )}
      {/* Everyone else just sees what the squad is playing for. */}
      {squadSettings?.prizeNote && squadSettings.ownerId !== userId && (
        <div className="mt-4 rounded-2xl p-3.5 bg-[var(--green)]/10 border border-[var(--green)]/25">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Playing for</div>
          <div className="text-sm font-bold mt-0.5">{squadSettings.prizeNote}</div>
        </div>
      )}

      <div className="flex items-center justify-between mt-6 mb-2"><div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF]">Group feed</div><button onClick={leaveSquad} className="mono text-[10px] text-[var(--muted)] underline">leave</button></div>
      <div className="space-y-2">
        {[...sq.feed].reverse().map((f: any) => {
          if (f.kind === "system") return <div key={f.id} className="text-center mono text-[10px] text-[#9CA3AF] py-1">— {f.text} —</div>;
          if (f.kind === "call") {
            // Q9 — when the commissioner hides picks until lock, someone else's call shows WHO called,
            // never WHAT they called. Hiding the copy button while leaving the side on screen would be
            // theatre. Your own call is always visible to you.
            const mine = f.userId === userId;
            // The SERVER decides what we may see: a concealed call arrives with no side and no reason.
            const concealed = !!f.concealed;
            return (
              <div key={f.id} className="bg-white border border-[var(--line)] rounded-xl p-3">
                <div className="flex items-center gap-1.5 text-sm">
                  <b>{f.name}</b>
                  {/* Q1 — the side you took, worn next to your name for the whole match. */}
                  {concealed
                    ? <span className="mono text-[9px] font-extrabold tracking-widest rounded px-1.5 py-0.5 bg-[#FAFAF7] text-[var(--muted)] border border-[var(--line)] shrink-0">SEALED</span>
                    : <SideBadge side={f.side} />}
                  <span className="text-[var(--muted)] truncate">{f.q}?</span>
                </div>
                {/* S5 — why they called it. Copying is a decision, not a reflex. */}
                {!concealed && f.reason && <div className="mt-1 text-[12px] text-[var(--muted)] italic">“{f.reason}”</div>}
                {concealed && <div className="mt-1.5 mono text-[10px] uppercase tracking-widest text-[var(--muted)]">Hidden until the lock</div>}
                {!mine && !concealed && (() => {
                  // Copy-a-Call depth (S5): tail count so a follow is considered, not blind. Fade (S6) puts
                  // you on the OTHER side and starts a named H2H duel.
                  const tail = sq.feed.filter((x: any) => x.kind === "call" && x.market === f.market && x.side === f.side).length;
                  return (
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => copyCall(f.market, f.side)} className="h-8 px-3 rounded-lg bg-[var(--ink)] text-white text-xs font-bold">Copy this call{tail > 1 ? ` · ${tail} on it` : ""}</button>
                      <button onClick={() => fadeDuel(f)} className="h-8 px-3 rounded-lg bg-white border border-[var(--ink)] text-xs font-bold">Fade {f.name}</button>
                    </div>
                  );
                })()}
              </div>
            );
          }
          // Called Shot (S2): a sealed one-liner. Stays shut until full-time, torn open ONLY if the call landed.
          if (f.kind === "shot") return (
            <div key={f.id} className="bg-white border border-[var(--line)] rounded-xl p-3">
              {!f.revealed ? (
                <div className="flex items-center gap-2.5">
                  <span className="w-8 h-8 rounded-lg bg-[var(--ink)] flex items-center justify-center shrink-0"><span className="w-4 h-3 border-2 border-white/70 rounded-[2px]" /></span>
                  <div><div className="text-sm"><b>{f.name}</b> sealed a Called Shot · {f.q}?</div><div className="mono text-[10px] text-[var(--muted)]">Torn open at full-time — only if it lands.</div></div>
                </div>
              ) : f.shotWin ? (
                <div>
                  <div className="mono text-[9px] tracking-widest uppercase text-[var(--green)]">Called Shot · opened</div>
                  <div className="text-[15px] font-bold mt-1 leading-snug">“{f.sealed}”</div>
                  <div className="mono text-[10px] text-[var(--muted)] mt-1">— {f.name} called it on {f.q}?</div>
                </div>
              ) : (
                <div className="text-sm text-[var(--muted)]"><b>{f.name}</b>&apos;s sealed shot on {f.q}? stayed shut — the call missed.</div>
              )}
            </div>
          );
          return (
            <div key={f.id} className="bg-white border border-[var(--line)] rounded-xl p-3">
              <div className="flex items-center gap-2"><span className="w-6 h-6 rounded-full bg-[var(--green)] text-white text-[10px] font-bold flex items-center justify-center">{(f.name[0] || "?").toUpperCase()}</span><span className="text-sm font-semibold">{f.name}</span></div>
              <div className="text-sm mt-1">{f.text}</div>
              <div className="flex gap-1 mt-2">{REACTS.map((em) => { const arr = f.reactions?.[em] || []; const mine = arr.includes(userId); return <button key={em} onClick={() => reactTo(f.id, em)} className={`h-7 px-2 rounded-full text-xs border ${mine ? "border-[var(--green)] bg-[var(--green)]/10" : "border-[var(--line)]"}`}>{em}{arr.length > 0 ? ` ${arr.length}` : ""}</button>; })}</div>
            </div>
          );
        })}
      </div>

      <div className="sticky bottom-0 mt-3 flex gap-2 bg-[var(--bg)] py-2">
        <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && msg.trim()) { postBanter(msg.trim()); setMsg(""); } }} placeholder="Talk your talk…" className="flex-1 h-11 rounded-xl border border-[var(--line)] px-4 bg-white" />
        <button disabled={!msg.trim()} onClick={() => { postBanter(msg.trim()); setMsg(""); }} className="px-4 h-11 rounded-xl bg-[var(--ink)] text-white font-bold disabled:opacity-40">Send</button>
      </div>
    </div>
  );
}

// Turn the raw tick stream into a fan-readable timeline: scoreline from the goal-count stats, a match
// clock from the running clock, and only the moments that matter (goals, cards, corners, big chances).
type TimelineKind = "goal" | "red" | "yellow" | "corner" | "chance" | "building";
function buildTimeline(recent: any[], home: string, away: string) {
  const evs: { min: string; kind: TimelineKind; text: string; big?: boolean }[] = [];
  let pg1 = 0, pg2 = 0, py = 0, pr = 0, pc = 0;
  for (const e of recent) {
    const s = e.Stats || {};
    const g1 = Number(s[1] || 0), g2 = Number(s[2] || 0);
    const yc = Number(s[3] || 0) + Number(s[4] || 0), rc = Number(s[5] || 0) + Number(s[6] || 0), co = Number(s[7] || 0) + Number(s[8] || 0);
    const min = e.Clock?.Seconds != null ? `${Math.floor(Number(e.Clock.Seconds) / 60)}'` : "";
    if (g1 > pg1) evs.push({ min, kind: "goal", text: `GOAL — ${home}`, big: true });
    if (g2 > pg2) evs.push({ min, kind: "goal", text: `GOAL — ${away}`, big: true });
    if (rc > pr) evs.push({ min, kind: "red", text: "Red card" });
    if (yc > py) evs.push({ min, kind: "yellow", text: "Booking" });
    if (co > pc) evs.push({ min, kind: "corner", text: "Corner" });
    if (e.Action === "high_danger_possession") evs.push({ min, kind: "chance", text: "Big chance", big: true });
    else if (e.Data?.Goal) evs.push({ min, kind: "building", text: "Goal building" });
    pg1 = g1; pg2 = g2; py = yc; pr = rc; pc = co;
  }
  return evs.slice(-14).reverse();
}

/** Drawn timeline markers — never emoji. A card is its coloured rectangle, a goal a filled ball, a
 *  corner a little flag, a chance a live green dot. Reads instantly, and matches the brand's drawn-asset
 *  rule (the one place emoji is allowed is banter reactions, not the match feed). */
function TimelineIcon({ kind }: { kind: TimelineKind }) {
  if (kind === "red") return <span className="inline-block w-3 h-4 rounded-[2px] bg-[#DC2626]" aria-label="red card" />;
  if (kind === "yellow") return <span className="inline-block w-3 h-4 rounded-[2px] bg-[#F5B01A]" aria-label="booking" />;
  if (kind === "corner") return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-label="corner" className="shrink-0"><rect x="2" y="1" width="1.5" height="14" rx="0.75" fill="var(--muted)" /><path d="M3.5 2.5 L11 4.5 L3.5 7 Z" fill="var(--green)" /></svg>
  );
  if (kind === "goal") return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="goal" className="shrink-0"><circle cx="8" cy="8" r="7" fill="var(--ink)" /><circle cx="8" cy="8" r="2.4" fill="#fff" /><circle cx="8" cy="3.4" r="1.1" fill="#fff" opacity="0.85" /><circle cx="12" cy="10" r="1.1" fill="#fff" opacity="0.85" /><circle cx="4" cy="10" r="1.1" fill="#fff" opacity="0.85" /></svg>
  );
  return <span className="inline-block w-2.5 h-2.5 rounded-full bg-[var(--green)] gf-pulse" aria-label={kind === "chance" ? "big chance" : "goal building"} />;
}

// THE GAFFER'S TAKE — an AI pundit reacting to the real match feed, with one-tap voice. Hidden in
// spoiler-safe mode (it reveals what just happened).
function GafferTake({ moment, home, away }: { moment: { kind: string; who: string; minute: string; detail: string } | null; home: string; away: string }) {
  const [line, setLine] = useState("");
  const [loading, setLoading] = useState(false);
  const sig = moment ? `${moment.kind}|${moment.who}|${moment.minute}` : "";
  useEffect(() => {
    if (!moment) { setLine(""); return; }
    let on = true; setLoading(true);
    punditLine({ kind: moment.kind, who: moment.who, home, away, minute: moment.minute, detail: moment.detail })
      .then((l) => { if (on) { setLine(l); setLoading(false); } });
    return () => { on = false; };
  }, [sig, home, away]); // eslint-disable-line react-hooks/exhaustive-deps
  const speak = () => { try { const u = new SpeechSynthesisUtterance(line); u.rate = 1.05; u.pitch = 0.95; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch { /* no TTS */ } };
  if (SPOILER_SAFE || !moment) return null;
  return (
    <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#211048,#0b0620)" }}>
      <div className="flex items-center justify-between">
        <div className="mono text-[10px] tracking-widest uppercase text-[#c4b5fd]">The Gaffer&apos;s Take</div>
        {line && <button onClick={speak} aria-label="Speak the take" className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center active:scale-90 transition-transform">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2.5 4.5 5.5H2v5h2.5L8 13.5z" fill="#fff" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" /></svg>
        </button>}
      </div>
      <div className="text-[16px] font-bold mt-2 leading-snug min-h-[44px]">{loading ? "…reading the game" : line ? `“${line}”` : ""}</div>
      <div className="mono text-[9px] text-white/40 mt-2">AI pundit · reacting live to the {home} v {away} feed</div>
    </div>
  );
}

/** THE GAFFER'S EAR — the autonomous agent that reads events (goal / stoppage / full-time) from the live
 * market alone, before the score feed carries them. Each call is committed on-chain the instant it's made;
 * we show the call and a link to that proof. Hidden until it has actually called something. */
type EarCall = { kind: string; side: string | null; team: string | null; confidence: number; evidence: string; sig: string | null; ts: number };
function GafferEar({ fixtureId }: { fixtureId: number }) {
  const [calls, setCalls] = useState<EarCall[]>([]);
  useEffect(() => {
    if (!fixtureId) return;
    let on = true;
    const read = () => fetch(`/api/ear-calls?fixture=${fixtureId}`).then((r) => r.json()).then((d) => { if (on) setCalls(d.calls || []); }).catch(() => {});
    read();
    const t = POLL ? setInterval(read, 15_000) : null;
    return () => { on = false; if (t) clearInterval(t); };
  }, [fixtureId]);
  if (!calls.length) return null;

  const headline = (c: EarCall) =>
    c.kind === "goal" ? `GOAL${c.team ? " — " + c.team : c.side === "draw" ? " — leveller" : ""}`
    : c.kind === "stoppage" ? "Under review" : "Full time";
  const glyph = (c: EarCall) =>
    c.kind === "goal" ? <TimelineIcon kind="goal" />
    : c.kind === "stoppage" ? <span className="inline-block w-3 h-3 rounded-[2px] bg-[#F5B01A]" />
    : <span className="mono text-[9px] font-bold text-[var(--muted)]">FT</span>;

  return (
    <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0b2a1e,#08130d)" }}>
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--greenb)] gf-pulse" />
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">The Gaffer&apos;s Ear</span>
      </div>
      <div className="mono text-[9px] text-white/40 mt-1">reads the match from the market — before the score feed. every call proved on-chain.</div>
      <div className="mt-3 space-y-2.5">
        {calls.slice(0, 5).map((c, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="w-5 mt-0.5 flex items-center justify-center shrink-0">{glyph(c)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold leading-tight">{headline(c)}</span>
                <span className="mono text-[9px] text-white/40">{(c.confidence * 100) | 0}%</span>
              </div>
              <div className="text-[11px] text-white/55 leading-snug mt-0.5">{c.evidence}</div>
            </div>
            {c.sig && <a href={`https://explorer.solana.com/tx/${c.sig}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="mono text-[9px] text-[var(--greenb)] shrink-0 mt-0.5 whitespace-nowrap">proof ↗</a>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** L7/L8 — the halftime beat. Halftime is ~6x the per-minute engagement of open play, so the break gets
 * one real decision: stick with your call, or twist it to the other side. Exactly one move per matchday,
 * at a fixed stake — the anti-predatory version of in-play agency. */
function HalftimeBeat({ pulse, onTwist, busy }: { pulse: LivePulse | null; onTwist: (side: "yes" | "no") => void; busy?: boolean }) {
  if (!pulse?.atHalftime) return null;
  const pick = pulse.pick;
  const other = pick?.side === "yes" ? "no" : "yes";
  return (
    <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white relative overflow-hidden">
      <div className="absolute -left-10 -top-12 w-36 h-36 rounded-full bg-[var(--green)] opacity-[0.16] blur-2xl" />
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Halftime</div>
      <div className="text-lg font-black mt-0.5">45 minutes left.</div>
      {pick ? (
        <>
          <p className="text-[12px] opacity-75 mt-1 leading-snug">
            You called <b className="opacity-100">{pick.side.toUpperCase()}</b> on “{pick.quest}”. Stick with it, or twist — one move a day, and your stake never changes.
          </p>
          {pulse.canTwist ? (
            <div className="mt-3 flex gap-2">
              <button disabled={busy} onClick={() => onTwist(other as "yes" | "no")} className="flex-1 py-2.5 rounded-xl bg-white text-[var(--ink)] font-bold text-sm disabled:opacity-40">
                Twist to {other.toUpperCase()}
              </button>
              <div className="flex-1 py-2.5 rounded-xl border border-white/25 text-center font-bold text-sm opacity-70">Stick</div>
            </div>
          ) : (
            <p className="mt-2 mono text-[10px] uppercase tracking-widest opacity-60">Your move is spent for today.</p>
          )}
        </>
      ) : (
        <p className="text-[12px] opacity-75 mt-1">No call on this match today — nothing to move.</p>
      )}
    </div>
  );
}

/** L2 — the market has stopped quoting. Shown as a state, never as a claim about what happened. */
function MarketQuiet({ pulse }: { pulse: LivePulse | null }) {
  if (!pulse?.marketQuiet || pulse.finished) return null;
  return (
    <div className="mt-3 rounded-2xl p-3.5 bg-white border border-[var(--line)] flex items-center gap-3">
      <span className="w-2 h-2 rounded-full bg-[#D8A32B] animate-pulse shrink-0" />
      <div className="text-[12px] leading-snug"><b>The market has gone quiet.</b> <span className="text-[var(--muted)]">Nobody&apos;s quoting. Something is happening.</span></div>
    </div>
  );
}

/** L5 — your live calls on this match, tracked from projected → cooking → paid off the real clock. */
function LiveCallTracker({ positions, markets, fixtureId, pulse }: { positions: any[]; markets: MarketView[]; fixtureId: number; pulse: LivePulse | null }) {
  const mine = positions
    .filter((p) => p.amount > 0 && !p.claimed)
    .map((p) => ({ p, m: markets.find((x) => x.pubkey === p.market) }))
    .filter((x) => x.m && Number(x.m!.fixtureId) === fixtureId && realMarket(x.m!));
  if (!mine.length) return null;

  const stage = (m: MarketView) => {
    if (isPaid(m)) return { label: "PAID", tone: "bg-[var(--green)] text-white" };
    if (m.status === 2) return { label: "REFUNDED", tone: "bg-[#FAFAF7] text-[var(--muted)] border border-[var(--line)]" };
    if (pulse?.running || pulse?.atHalftime) return { label: "COOKING", tone: "bg-[#D8A32B] text-white" };
    return { label: "PROJECTED", tone: "bg-[#FAFAF7] text-[var(--muted)] border border-[var(--line)]" };
  };

  return (
    <div className="mt-4">
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)] mb-2">Your calls, live</div>
      <div className="space-y-2">
        {mine.map(({ p, m }) => {
          const s = stage(m!);
          return (
            <div key={m!.pubkey + ":" + p.side} className="bg-white border border-[var(--line)] rounded-2xl p-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold truncate">{label(m!).q}?</div>
                <div className="mono text-[10px] text-[var(--muted)]">{fmtAmt(p.amount)} on {p.side === 1 ? "YES" : "NO"}</div>
              </div>
              <span className={`mono text-[9px] font-extrabold tracking-widest rounded px-2 py-1 shrink-0 ${s.tone}`}>{s.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Live({ fixtureId, onFreeze, onBlackout, userId, squadCode, userName, positions = [], markets = [], flash }: any) {
  const [scores, setScores] = useState<any>(null);
  const [err, setErr] = useState(false);
  const [pulse, setPulse] = useState<LivePulse | null>(null);
  const [twistBusy, setTwistBusy] = useState(false);
  const f = fx(fixtureId);
  useEffect(() => {
    let on = true;
    const tick = () => getScores(fixtureId).then((s) => { if (on) { s?.error ? setErr(true) : (setScores(s), setErr(false)); } }).catch(() => on && setErr(true));
    tick(); if (!POLL) return () => { on = false; };
    const t = setInterval(tick, 8000);
    return () => { on = false; clearInterval(t); };
  }, [fixtureId]);

  // The live pulse drives the halftime beat, the market-quiet strip and the call tracker.
  useEffect(() => {
    let on = true;
    const tick = () => livePulse(fixtureId, userId || undefined, squadCode).then((p) => on && setPulse(p)).catch(() => {});
    tick(); if (!POLL) return () => { on = false; };
    const t = setInterval(tick, 8000);
    return () => { on = false; clearInterval(t); };
  }, [fixtureId, userId, squadCode]);

  const doTwist = async (side: "yes" | "no") => {
    if (twistBusy) return;
    setTwistBusy(true);
    try {
      const tok = typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "";
      const r = await twistCall({ userId, token: tok, fixtureId, side, squadCode: squadCode || null, name: userName });
      if (r?.ok) { flash?.(`Twisted — you're on ${side.toUpperCase()} now.`, "ok"); setPulse(await livePulse(fixtureId, userId || undefined, squadCode)); }
      else flash?.(r?.reason || "Couldn't move that call.", "err");
    } finally { setTwistBusy(false); }
  };

  const recent: any[] = scores?.recent || [];
  const latest = recent[recent.length - 1];
  // A real reported score, or nothing — `Stats[1] || 0` used to turn "no data" into a fabricated 0–0.
  const hasScore = latest?.Stats?.[1] != null;
  const g1 = hasScore ? Number(latest.Stats[1]) : null;
  const g2 = hasScore ? Number(latest.Stats[2] ?? 0) : null;
  const secs = latest?.Clock?.Seconds != null ? Number(latest.Clock.Seconds) : null;
  // In play if the score stream's clock is running, OR the odds stream says so (pulse.liveFromOdds) when
  // the score stream is silent — which is how the whole match looks on the dev feed.
  const running = latest?.Clock?.Running;
  const live = !!(running || pulse?.running);
  const state: string = latest?.GameState || "";
  const clock = secs != null ? `${Math.floor(secs / 60)}'` : "";
  // The eyebrow says what the match is doing; the right-hand slot carries the clock, and only the clock.
  // Both used to fall back to the words "Match Centre", which the section header above already says —
  // pre-match the card read "MATCH CENTRE … Match Centre" under a "Match Centre ·" title.
  // When neither stream has said anything we do not know whether the match is hours away or long over,
  // so the card says nothing rather than guessing.
  const status = live ? "Live" : !latest ? "" : state === "scheduled" ? "Kick-off soon" : clock ? "Paused" : "Full time";
  const timeline = buildTimeline(recent, f.home, f.away);
  // The freshest punditworthy moment for The Gaffer's Take (goal > red > chance; corners/bookings skipped).
  const bigMoment = useMemo(() => {
    const e = timeline.find((x) => /GOAL/.test(x.text)) || timeline.find((x) => /Red/.test(x.text)) || timeline.find((x) => x.big) || null;
    if (!e) return null;
    let kind = "chance", who = f.home;
    if (/GOAL/.test(e.text)) { kind = "goal"; who = e.text.includes(f.away) ? f.away : f.home; }
    else if (/Red/.test(e.text)) kind = "red";
    else if (/chance/i.test(e.text)) kind = "chance";
    return { kind, who, minute: e.min, detail: e.text };
  }, [timeline, f.home, f.away]);

  return (
    <div>
      <Section title={`Match Centre · ${f.home} v ${f.away}`} />
      <HalftimeBeat pulse={pulse} onTwist={doTwist} busy={twistBusy} />
      <MarketQuiet pulse={pulse} />
      <LiveCallTracker positions={positions} markets={markets} fixtureId={fixtureId} pulse={pulse} />
      <div className="mt-4 bg-[var(--ink)] rounded-3xl p-6 text-white relative overflow-hidden">
        {/* per-match identity: both kits as a floodlit color wash behind the scoreline */}
        <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: `linear-gradient(90deg, ${team(f.home).primary} 0%, ${team(f.home).primary} 42%, ${team(f.away).primary} 58%, ${team(f.away).primary} 100%)` }} />
        <div className="absolute -left-10 -top-10 w-44 h-44 rounded-full opacity-[0.16]" style={{ background: `radial-gradient(circle, ${team(f.home).primary}, transparent 70%)` }} />
        <div className="absolute -right-10 -top-10 w-44 h-44 rounded-full opacity-[0.16]" style={{ background: `radial-gradient(circle, ${team(f.away).primary}, transparent 70%)` }} />
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{live && <span className="inline-block w-2 h-2 rounded-full bg-[var(--greenb)] gf-pulse mr-1.5 align-middle" />}{status}</span>
          <span className="mono text-[10px] text-[#9CA3AF]">{running ? clock : ""}</span>
        </div>
        {SPOILER_SAFE ? (
          <div className="flex items-center justify-center gap-5 mt-4">
            <div className="flex-1 flex flex-col items-end gap-1.5"><Flag name={f.home} size={34} round /><div className="text-[15px] font-bold text-right leading-tight">{f.home}</div></div>
            <div className="text-4xl font-extrabold tabular-nums text-[#6B7280]">•&nbsp;–&nbsp;•</div>
            <div className="flex-1 flex flex-col items-start gap-1.5"><Flag name={f.away} size={34} round /><div className="text-[15px] font-bold leading-tight">{f.away}</div></div>
          </div>
        ) : err && !scores ? (
          <div className="text-sm text-[#9CA3AF] mt-4 text-center py-4">Match feed is catching its breath — back in a moment.</div>
        ) : !scores ? (
          <div className="text-sm text-[#9CA3AF] mt-4 text-center py-4">Connecting to the match…</div>
        ) : (
          <div className="flex items-center justify-center gap-5 mt-4">
            <div className="flex-1 flex flex-col items-end gap-1.5"><Flag name={f.home} size={34} round /><div className="text-[15px] font-bold text-right leading-tight">{f.home}</div></div>
            {/* A real score, or honest dots — never a 0–0 the feed didn't report. */}
            {hasScore
              ? <div className="text-5xl font-extrabold tabular-nums">{g1}<span className="text-[#6B7280] px-2">–</span>{g2}</div>
              : <div className="text-4xl font-extrabold tabular-nums text-[#6B7280]">•&nbsp;–&nbsp;•</div>}
            <div className="flex-1 flex flex-col items-start gap-1.5"><Flag name={f.away} size={34} round /><div className="text-[15px] font-bold leading-tight">{f.away}</div></div>
          </div>
        )}
        <div className="text-[12px] text-[#9CA3AF] mt-4 text-center">{live && !hasScore ? "Kicked off — the market's already moving. The score lands here the moment the feed calls it." : "Make a call from Today and watch it settle the second it counts."}</div>
      </div>

      {/* THE GAFFER'S TAKE — AI pundit on the real feed (the track's "AI Pundit", with voice). */}
      <GafferTake moment={bigMoment} home={f.home} away={f.away} />

      {/* THE GAFFER'S EAR — the autonomous agent reading events from the market, each with on-chain proof. */}
      <GafferEar fixtureId={fixtureId} />

      {/* THE FROZEN WINDOW — the one surface that opens exactly when every sportsbook locks its doors. */}
      <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#111,#0b2a1e)" }}>
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">The Frozen Window</div>
        <div className="text-[15px] font-bold mt-1.5 leading-snug">The minute every sportsbook locks its doors, our round opens — and winners are paid before the commentator finishes his sentence.</div>
        <div className="flex gap-2 mt-3">
          <button onClick={onFreeze} className="flex-1 h-11 rounded-xl bg-white text-[var(--ink)] font-bold text-sm">The Freeze</button>
          <button onClick={onBlackout} className="flex-1 h-11 rounded-xl bg-[#1d1d1f] border border-[#2c2c2e] font-bold text-sm">Blackout</button>
        </div>
        <div className="mono text-[10px] text-[#6B7280] mt-2">Replays a real VAR / market-silence moment from the match feed.</div>
      </div>

      <Section title="Timeline" />
      {SPOILER_SAFE ? (
        <div className="text-sm text-[var(--muted)] py-4 text-center bg-white border border-[var(--line)] rounded-2xl">Spoiler-safe is on — match events hidden. Turn it off in You.</div>
      ) : (<>
      {scores && timeline.length === 0 && <div className="text-sm text-[var(--muted)] py-4 text-center">No big moments yet — it&apos;s all to play for.</div>}
      <div className="space-y-1">
        {timeline.map((ev, i) => (
          <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${ev.big ? "bg-[var(--green)]/10" : "bg-white border border-[var(--line)]"}`}>
            <span className="mono text-[11px] font-semibold w-9 text-[var(--muted)]">{ev.min}</span>
            <span className="w-6 flex items-center justify-center"><TimelineIcon kind={ev.kind} /></span>
            <span className={`text-sm flex-1 ${ev.big ? "font-bold" : ""}`}>{ev.text}</span>
          </div>
        ))}
      </div>
      </>)}
    </div>
  );
}

function FrozenWindow({ round, userId, onCall, onDismiss, onPinLore }: any) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  // Ease the "in the window" count up toward the live presence so the room visibly fills, never a flat 0.
  const [disp, setDisp] = useState(0);
  useEffect(() => { let h: any; const step = () => { setDisp((d) => { const t = round.presence || 0; return Math.abs(t - d) < 1 ? t : d + (t - d) * 0.2; }); h = setTimeout(step, 90); }; step(); return () => clearTimeout(h); }, [round.presence]);
  const f = fx(round.fixtureId);
  const freeze = round.kind === "freeze";
  const myCall: string | undefined = round.calls?.find((c: any) => c.userId === userId)?.side;
  const settled = round.state === "settled";
  const locked = settled || now >= round.locksAt;
  const secsToLock = Math.max(0, Math.ceil((round.locksAt - now) / 1000));
  const presence: number = round.presence || 0;
  const roomTally: Record<string, number> = round.roomTally || {};
  const roomTotal = Math.max(1, Object.values(roomTally).reduce((a: number, b: any) => a + Number(b), 0));
  const namedCalls: { name: string; side: string }[] = (round.calls || []).filter((c: any) => c.name && c.name !== "You");
  const sweat: { t: number; pct: number }[] = round.sweat || [];
  const lastPct = sweat.length ? sweat[sweat.length - 1].pct : null;
  const won = settled && myCall && myCall === round.outcome;
  // A "% of the room" only means something with enough real callers — below that it's noise (2 people =
  // "50%"). Mirror how recap/economy null-out small cohorts: no percentage until the room is real.
  const ROOM_FLOOR = 4;
  const roomReadPct = settled && round.outcome && presence >= ROOM_FLOOR ? Math.round(((roomTally[round.outcome] || 0) / roomTotal) * 100) : null;

  // option → label (Blackout maps HOME/AWAY to team names)
  const optLabel = (o: string) => (o === "HOME GOAL" ? `${f.home} GOAL` : o === "AWAY GOAL" ? `${f.away} GOAL` : o);
  // High-contrast super-tap: unchosen options are SOLID (never a ghostly white/10 that reads as disabled);
  // the chosen one gets a ring. STANDS=green, OVERTURNED=red, Blackout options=ink-on-white.
  const optClass = (o: string) => {
    const chosen = myCall === o;
    if (o === "STANDS") return chosen ? "bg-[var(--green)] text-white ring-2 ring-white/50" : "bg-white text-[var(--ink)]";
    if (o === "OVERTURNED") return chosen ? "bg-red-600 text-white ring-2 ring-white/50" : "bg-white text-red-600";
    return chosen ? "bg-[var(--greenb)] text-[var(--ink)] ring-2 ring-white/50" : "bg-white/90 text-[var(--ink)]";
  };

  const bg = freeze
    ? "radial-gradient(120% 90% at 50% 25%, #0b3b2a, #05100b)"
    : "radial-gradient(120% 90% at 50% 30%, #14141a, #060608)";

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center text-white px-7 text-center" style={{ background: bg }}>
      {/* Escape hatch — never trap the user in the takeover (audit #3). */}
      <button onClick={onDismiss} aria-label="Close" className="absolute top-5 right-5 z-10 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white/70 text-lg leading-none active:bg-white/20">✕</button>
      {!settled ? (
        <>
          <div className="flex items-center justify-center gap-2 mono text-[10px] tracking-[0.3em] uppercase text-[var(--greenb)]">{freeze ? "The Freeze" : "Blackout"} · <FlagPair home={f.home} away={f.away} size={14} /></div>
          {freeze ? (
            <>
              <h2 className="text-3xl font-extrabold tracking-tight mt-4 leading-tight">GOAL UNDER REVIEW</h2>
              <p className="text-white/70 mt-2 text-[15px]">The books just froze. We don&apos;t. <b className="text-white">Does it stand?</b></p>
            </>
          ) : (
            <>
              <h2 className="text-5xl font-extrabold tracking-tight mt-4">…</h2>
              <p className="text-white/70 mt-2 text-[15px]">The market just went quiet. <b className="text-white">Call what happens next.</b></p>
            </>
          )}
          <p className="text-white/50 text-[13px] mt-1">{round.note}</p>

          {/* lock countdown */}
          {!locked ? (
            <div className="mt-5 flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[var(--greenb)] gf-pulse" /><span className="mono text-sm">Locks in {secsToLock}s</span></div>
          ) : (
            <div className="mt-5 mono text-sm text-white/60">Locked — sweating it out</div>
          )}

          {/* options */}
          <div className={`mt-4 w-full max-w-xs grid ${round.options.length > 2 ? "grid-cols-1" : "grid-cols-2"} gap-2`}>
            {round.options.map((o: string) => (
              <button key={o} disabled={locked || !!myCall} onClick={() => onCall(round.id, o)} className={`h-14 rounded-2xl font-extrabold disabled:opacity-70 ${optClass(o)}`}>{optLabel(o)}</button>
            ))}
          </div>
          {myCall && <div className="mt-3 mono text-[11px] text-white/60">You called <b className="text-white">{optLabel(myCall)}</b></div>}

          {/* The room, live — how the REAL people in this window are splitting. Only shown once enough have
              called for a split to mean anything; below that the named-calls rail below carries it. */}
          {presence >= ROOM_FLOOR && (
            <div className="mt-5 w-full max-w-xs">
              <div className="flex h-2.5 rounded-full overflow-hidden bg-white/10">
                {round.options.map((o: string) => {
                  const w = ((roomTally[o] || 0) / roomTotal) * 100;
                  const col = o === "STANDS" ? "var(--green)" : o === "OVERTURNED" ? "#dc2626" : o === "HOME GOAL" ? "var(--greenb)" : o === "AWAY GOAL" ? "#f59e0b" : "#6b7280";
                  return <div key={o} style={{ width: `${w}%`, background: col }} className="transition-all duration-500" />;
                })}
              </div>
              <div className="mt-1.5 flex justify-between mono text-[9px] text-white/45">
                {round.options.map((o: string) => (<span key={o}>{optLabel(o)} {Math.round(((roomTally[o] || 0) / roomTotal) * 100)}%</span>))}
              </div>
            </div>
          )}

          {/* the squad rail — the real named people calling it, in-frame beside you */}
          {namedCalls.length > 0 && (
            <div className="mt-4 w-full max-w-xs flex gap-1.5 overflow-x-auto no-scrollbar">
              {namedCalls.slice(-8).map((c, i) => (
                <span key={i} className="shrink-0 mono text-[10px] px-2 py-1 rounded-full bg-white/10 text-white/80">{c.name} · {optLabel(c.side).replace(" GOAL", "")}</span>
              ))}
            </div>
          )}

          {/* the market-sweat strip — display only, the real crowd belief */}
          {locked && (
            <div className="mt-6 w-full max-w-xs">
              {lastPct != null ? (
                <>
                  <div className="mono text-[10px] tracking-widest uppercase text-white/40">The crowd&apos;s belief</div>
                  <div className="text-2xl font-extrabold text-[var(--greenb)] tabular-nums">{sweat.map((s) => `${s.pct.toFixed(0)}%`).slice(-4).join(" → ")}</div>
                  <div className="mono text-[10px] text-white/40 mt-1">even the money can&apos;t decide</div>
                </>
              ) : (
                <div className="mono text-[11px] text-white/40">the market is holding its breath…</div>
              )}
            </div>
          )}
          <div className="mt-5 flex items-center gap-2 mono text-[11px] text-white/45"><span className="w-1.5 h-1.5 rounded-full bg-[var(--greenb)] gf-pulse" />{presence > 0 ? <><b className="text-white/80 tabular-nums">{Math.round(disp)}</b> in the window — verdict pays the readers</> : <>be the first to call it — verdict pays the readers</>}</div>
        </>
      ) : (
        /* ── the reveal ── */
        <div className="gf-pop w-full max-w-xs">
          <div className="mono text-[10px] tracking-[0.3em] uppercase text-white/40">{freeze ? "The Freeze" : "Blackout"} · verdict</div>
          <div className={`text-4xl font-extrabold tracking-tight mt-3 ${round.outcome === "OVERTURNED" || round.outcome === "NO GOAL" ? "text-red-400" : "text-[var(--greenb)]"}`}>{optLabel(round.outcome)}</div>
          <div className="text-white/60 text-sm mt-2">{round.lore}</div>
          <div className="mt-5 rounded-2xl bg-white/10 p-4">
            {won ? (
              <><div className="text-2xl font-extrabold text-[var(--greenb)]">You read it right</div><div className="mono text-sm text-white/70 mt-1">+40 points</div></>
            ) : myCall ? (
              <><div className="text-xl font-bold">Not this time</div><div className="mono text-[12px] text-white/50 mt-1">you called {optLabel(myCall)}</div></>
            ) : (
              <div className="text-lg font-bold text-white/70">You sat this one out</div>
            )}
          </div>
          {/* Verdict Brief — how the whole room read it, and where you landed in it. */}
          {roomReadPct != null && (
            <div className="mt-3 mono text-[12px] text-white/55 leading-relaxed">
              <b className="text-white/80">{roomReadPct}%</b> of the {presence} in the window read it {roomReadPct >= 50 ? "right" : "wrong"}.
              {won ? " You were one of them." : myCall ? " You weren't — next one's yours." : " Sat this one out."}
            </div>
          )}
          <div className="mt-5 flex gap-2">
            {won && <button onClick={() => onPinLore(`${optLabel(round.outcome)} — I called it. ${round.lore}`)} className="flex-1 py-3.5 rounded-2xl bg-white/15 text-white font-bold text-sm">📌 Pin to lore</button>}
            <button onClick={onDismiss} className="flex-1 py-3.5 rounded-2xl bg-white text-[#05100b] font-bold">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// One row in "Your calls" — a position you still hold money in, with the single right action for its
// state: collect winnings, get a refund, crank-and-collect a finished pool, or (lost) a quiet nudge on.
function CallRow({ m, p, busy, claim, collect, onOpen }: any) {
  const l = label(m);
  const b = busy === "collect:" + m.pubkey || busy === "claim:" + m.pubkey;
  const won = isPaid(m) && p.side === wonSide(m);
  const lost = isPaid(m) && p.side !== wonSide(m);
  const refund = m.status === 2;
  const open = m.status === 0;
  const chip = won ? { t: "WON", c: "text-[var(--green)]" } : lost ? { t: "DIDN'T LAND", c: "text-[#9CA3AF]" } : refund ? { t: "CALLED OFF", c: "text-[#9CA3AF]" } : { t: "IN PLAY", c: "text-[var(--ink)]" };
  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4 mb-2">
      <button onClick={onOpen} className="w-full text-left">
        <div className="flex items-center justify-between">
          <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">{l.match}</div>
          <div className={`mono text-[9px] font-bold tracking-widest ${chip.c}`}>{chip.t}</div>
        </div>
        <div className="font-bold mt-0.5">{l.q}?</div>
      </button>
      <div className="mt-1 text-[13px] text-[var(--muted)]">Your call: <b className="text-[var(--ink)]">{money(p.amount)}</b> on {p.side === 1 ? "YES" : "NO"}</div>
      {won && <button disabled={b} onClick={() => claim(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{b ? "collecting…" : "Collect your winnings →"}</button>}
      {refund && <button disabled={b} onClick={() => claim(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--ink)] text-white font-bold disabled:opacity-50">{b ? "…" : "Get your money back →"}</button>}
      {open && <button disabled={b} onClick={() => collect(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{b ? "checking the result…" : "Collect →"}</button>}
      {lost && <div className="mt-3 text-[13px] text-[var(--muted)]">This one didn&apos;t land. On to the next.</div>}
    </div>
  );
}

function Cash({ bal, fund, busy, markets, claim, collect, setDetail, positions = [], econ }: any) {
  // Every position you still hold money in, joined to its pool. Winners first (you're owed now), then
  // live calls still in play; lost calls sink to the bottom. One tap collects/settles each.
  const mine = positions
    .filter((p: any) => p.amount > 0 && !p.claimed)
    .map((p: any) => ({ p, m: markets.find((x: MarketView) => x.pubkey === p.market) }))
    .filter((x: any) => x.m && realMarket(x.m));   // never surface a pool we can't truthfully name
  const rank = (x: any) => (isPaid(x.m) && x.p.side === wonSide(x.m) ? 0 : x.m.status === 2 ? 1 : x.m.status === 0 ? 2 : 3);
  mine.sort((a: any, b: any) => rank(a) - rank(b));
  return (
    <div>
      <Section title="Your cash" />
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white">
        <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Balance</div>
        <div className="flex items-baseline gap-2 mt-2">
          <TickNum value={bal} className="text-5xl font-extrabold tracking-tight" />
          <div className="mono text-[11px] uppercase tracking-widest text-[#9CA3AF]">{COIN}</div>
        </div>
        <div className="mt-2 text-[12px] text-[var(--greenb)]">✓ Yours instantly. Can&apos;t be clawed back.</div>
        <button disabled={busy === "fund"} onClick={fund} className="mt-5 w-full h-12 rounded-xl bg-white text-[var(--ink)] font-bold disabled:opacity-50">{busy === "fund" ? "Adding…" : "Add funds"}</button>
      </div>
      <Section title="Your calls" />
      {mine.length === 0 && <div className="text-sm text-[var(--muted)] py-4">No calls in play. Back one on Today and it lands here — collect the second it does.</div>}
      {mine.map(({ p, m }: any) => (
        <CallRow key={m.pubkey + ":" + p.side} m={m} p={p} busy={busy} claim={claim} collect={collect} onOpen={() => setDetail?.(m)} />
      ))}
      <BiggestWins econ={econ} />
    </div>
  );
}

/** C6 — the biggest wins, public and pseudonymous. Every number here came off a real settled pool: the
 * payout is the winner's own on-chain lamport delta, so nothing on this board can be staged. Names only,
 * never addresses. This is the whale-watching feed the category runs on — with receipts. */
function BiggestWins({ econ }: { econ: Economy | null }) {
  const wins = econ?.biggestWins ?? [];
  if (!wins.length) return null;
  return (
    <>
      <Section title="Biggest wins" />
      <div className="space-y-2">
        {wins.slice(0, 6).map((w, i) => {
          const mult = w.stake > 0 ? w.payout / w.stake : null;
          return (
            <div key={i} className="bg-white border border-[var(--line)] rounded-2xl p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-bold truncate">{w.name}</div>
                  {w.question ? <div className="text-[12px] text-[var(--muted)] truncate">{w.question}</div> : null}
                </div>
                <div className="text-right shrink-0">
                  {w.stake > 0 ? (
                    <div className="flex items-baseline gap-1.5">
                      <span className="mono text-[11px] text-[var(--muted)] tabular-nums">{fmtAmt(w.stake)}</span>
                      <span className="text-[10px] text-[#9CA3AF]">→</span>
                      <span className="text-lg font-extrabold text-[var(--green)] tabular-nums">{fmtAmt(w.payout)}</span>
                    </div>
                  ) : (
                    <span className="text-lg font-extrabold text-[var(--green)] tabular-nums">{fmtAmt(w.payout)}</span>
                  )}
                  <div className="mono text-[9px] text-[#9CA3AF]">
                    {mult ? `${mult.toFixed(2)}×` : ""}{mult && w.calledAt != null ? " · " : ""}{w.calledAt != null ? `called at ${w.calledAt}%` : ""}
                  </div>
                </div>
              </div>
              {settledAfterLabel(w.settledAfterMs) ? (
                <div className="mt-1.5 mono text-[9px] uppercase tracking-widest text-[var(--green)]">{settledAfterLabel(w.settledAfterMs)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)] leading-snug">Every payout here is read straight off the chain. Nobody can stage a win on this board.</p>
    </>
  );
}

/** Start fresh (Y-P1) — one-tap-to-arm, tap-again-to-confirm data wipe (squad, streak, wallet, all local
 * state). Two-step so it can never fire by accident; a real privacy control ("delete my data"). */
function StartFresh() {
  const [armed, setArmed] = useState(false);
  const wipe = () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return; }
    try { Object.keys(localStorage).filter((k) => k.startsWith("gaffer_")).forEach((k) => localStorage.removeItem(k)); } catch { /* private mode */ }
    if (typeof window !== "undefined") window.location.reload();
  };
  return (
    <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between gap-3">
      <div><div className="font-bold text-[15px]">Start fresh</div><div className="text-[12px] text-[var(--muted)] mt-0.5">Wipe your data from this device — squad, streak, everything.</div></div>
      <button onClick={wipe} className={`h-9 px-3 rounded-lg text-sm font-bold shrink-0 transition-colors ${armed ? "bg-red-600 text-white" : "bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)]"}`}>{armed ? "Tap to confirm" : "Reset"}</button>
    </div>
  );
}

/** Spoiler-delay (L6) — "match my stream": how many seconds to hold a reveal so it lines up with a
 * broadcast delay. Persists to localStorage; the live-score surfaces read it. Demand-proven (verbatim
 * requests on r/apps; FotMob needed a FAQ for "alerts ahead of my stream"). */
function SpoilerDelay() {
  const [d, setD] = useState<number>(() => (typeof window !== "undefined" ? Number(localStorage.getItem("gaffer_spoiler_delay") || 0) : 0));
  const set = (v: number) => { setD(v); if (typeof window !== "undefined") localStorage.setItem("gaffer_spoiler_delay", String(v)); };
  return (
    <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4">
      <div className="font-bold text-[15px]">Match my stream</div>
      <div className="text-[12px] text-[var(--muted)] mt-0.5 mb-2.5">Delay reveals to line up with your broadcast.</div>
      <div className="flex gap-2">
        {[0, 15, 30, 60].map((v) => (<button key={v} onClick={() => set(v)} className={`flex-1 h-9 rounded-lg text-[13px] font-bold ${d === v ? "bg-[var(--ink)] text-white" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{v === 0 ? "Off" : `${v}s`}</button>))}
      </div>
    </div>
  );
}

function You({ streak, bal, points, nation, userName, userId, flash, cfg, muted, toggleMute, spoiler, toggleSpoiler, econ, onWager, onEarnBack, econBusy }: any) {
  const rake = cfg?.rakeBps ?? 0;
  const cap = ((cfg?.maxRakeBps ?? 500) / 100).toFixed(0);
  const [pushPerm, setPushPerm] = useState<string>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const [receipts, setReceipts] = useState<any[]>([]);
  useEffect(() => {
    setPushPerm(pushPermission());
    try { setReceipts(JSON.parse(localStorage.getItem("gaffer_receipts") || "[]")); } catch { /* none */ }
  }, []);
  const shareReceipt = async (r: any) => {
    const stamp = r.calledAt != null ? ` Called it at ${r.calledAt}%${r.mult ? ` — paid ${r.mult.toFixed(2)}×` : ""}.` : "";
    const text = `I called it on GAFFER — +${money(r.amount)} on "${r.q}".${stamp} 🟢 gaffer-cyan.vercel.app`;
    try {
      if ((navigator as any).share) await (navigator as any).share({ text });
      else { await navigator.clipboard.writeText(text); flash?.("Receipt copied"); }
    } catch { /* dismissed */ }
  };
  const enableAlerts = async () => {
    setPushBusy(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "";
      const squad = typeof window !== "undefined" ? localStorage.getItem("gaffer_squad") || null : null;
      const ok = await enablePush(userId, token, squad);
      setPushPerm(pushPermission());
      flash?.(ok ? "Alerts on — we'll ping you when the window opens" : "Couldn't turn on alerts", ok ? "ok" : "err");
    } finally { setPushBusy(false); }
  };
  const [grid, setGrid] = useState<{ cells: ("hit" | "freeze" | "miss")[]; streak: number; alivePct: number | null } | null>(null);
  useEffect(() => { if (userId) streakGridApi(userId).then(setGrid); }, [userId]);
  // C5 — read the persisted sound preference after mount (localStorage is client-only).
  const [stadium, setStadium] = useState(false);
  useEffect(() => { setStadium(soundOn()); }, []);
  const name = userName && userName !== "You" ? userName : "You";
  const shareGrid = async () => {
    if (!grid) return;
    const text = streakGridText(grid.cells, grid.streak, grid.alivePct);
    try {
      if ((navigator as any).share) await (navigator as any).share({ text });
      else { await navigator.clipboard.writeText(text); flash?.("Streak grid copied"); }
      const tok = typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "";
      if (userId && tok) pointsApi("share", { userId, token: tok }); // first share earns points (idempotent)
    } catch { /* dismissed */ }
  };
  return (
    <div>
      <Section title="You" />
      <div className="flex items-center gap-4">
        <div className="relative">
          <div className="w-16 h-16 rounded-full bg-[var(--ink)] text-white flex items-center justify-center text-xl font-bold">{(name[0] || "Y").toUpperCase()}</div>
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white"><Flag name={nation} size={20} round /></span>
        </div>
        <div><div className="text-2xl font-bold">{name}</div><div className="flex items-center gap-1.5 mono text-[10px] text-[var(--muted)]"><Flag name={nation} size={11} round />{nation} · {points} pts</div></div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-5">
        {[[streak, "DAY STREAK"], [points, "POINTS"], [fmtAmt(bal), "BALANCE"]].map(([v, k]: any, i: number) => (<div key={i} className="bg-white border border-[var(--line)] rounded-2xl p-4"><div className="text-3xl font-extrabold tabular-nums">{v}</div><div className="mono text-[9px] tracking-wide text-[#9CA3AF] mt-1">{k}</div></div>))}
      </div>

      {/* Y3 rank + weekly league, T3 the wager. Rank is lifetime-earned (spending never demotes). */}
      <div className="mt-3 space-y-3">
        <TierCard econ={econ} />
        <WagerCard econ={econ} onWager={onWager} onEarnBack={onEarnBack} busy={econBusy} />
        <LeagueTable econ={econ} name={name} />
      </div>

      {/* "Your Cup so far" — the shareable peak-end recap, built from real stats the fan already has. */}
      <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0e0e0f,#10261d)" }}>
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Your Cup so far</div>
        <div className="flex items-center gap-1.5 text-lg font-bold mt-2">{name} · flying <Flag name={nation} size={16} round /> {nation}</div>
        <div className="flex gap-6 mt-3">
          {[[streak, "day streak"], [points, "points"], [receipts.length, "calls landed"]].map(([v, k]: any, i: number) => (<div key={i}><div className="text-2xl font-extrabold tabular-nums">{v}</div><div className="mono text-[9px] text-white/45 uppercase tracking-wide mt-0.5">{k}</div></div>))}
        </div>
        <button onClick={() => { const text = `My World Cup on GAFFER 🟢 ${streak}-day streak · ${points} pts · ${receipts.length} calls landed · flying ${nation}. gaffer-cyan.vercel.app`; if ((navigator as any).share) (navigator as any).share({ text }).catch(() => {}); else { navigator.clipboard.writeText(text); flash?.("Your Cup copied — paste it in the chat"); } }} className="mt-4 h-9 px-4 rounded-lg bg-white text-[var(--ink)] text-sm font-bold">Share your Cup</button>
      </div>

      {/* One-screen scoring explainer (Y6) — plain language, no fake precision. Points track your read, not luck. */}
      <details className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4">
        <summary className="font-bold text-[15px] cursor-pointer list-none flex items-center justify-between">How points work<span className="mono text-[10px] text-[var(--muted)]">tap</span></summary>
        <div className="mt-3 space-y-1.5 text-[13px] text-[var(--muted)]">
          <div className="flex justify-between"><span>Make your free daily call</span><span className="font-bold text-[var(--ink)]">+5</span></div>
          <div className="flex justify-between"><span>Back a call with coins</span><span className="font-bold text-[var(--ink)]">+3</span></div>
          <div className="flex justify-between"><span>Land a call (it comes in)</span><span className="font-bold text-[var(--green)]">+25</span></div>
          <div className="flex justify-between"><span>Keep your streak alive</span><span className="font-bold text-[var(--ink)]">bonus</span></div>
          <p className="pt-2 leading-relaxed">Points track your football read — how often you call it right — not luck and not how much you put in. No hidden multipliers, no fake accuracy scores.</p>
        </div>
      </details>
      <StartFresh />
      {/* The receipt wall — your greatest calls as artifacts (Sofascore's citation-currency lesson:
          the thing people screenshot IS the brand). */}
      {/* Foresight record (Y1) — the W-L line, the boldest correct call, and the Called Shot ledger.
          All server-derived from graded picks and settled wins: this is the record fans screenshot
          ("19-1 on my last 20 picks"), so it must be true or it's worthless. */}
      {(() => {
        const f = econ?.foresight;
        if (!f || (f.wins + f.losses + f.shotsOpened + f.shotsSealed) === 0) return null;
        const beat = econ?.percentileToday, medal = econ?.medalToday;
        return (
          <div className="mt-6 rounded-2xl p-4 bg-[var(--green)]/10 border border-[var(--green)]/25">
            <div className="flex items-center justify-between">
              <div className="mono text-[10px] tracking-widest uppercase text-[var(--green)]">Foresight</div>
              {medal ? <Medal tier={medal} size={16} /> : null}
            </div>
            {f.wins + f.losses > 0 ? (
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-black tabular-nums">{f.wins}–{f.losses}</span>
                <span className="mono text-[10px] text-[var(--muted)]">this Cup</span>
              </div>
            ) : null}
            {f.boldest != null ? <div className="text-[13px] font-bold mt-0.5">Boldest call landed at {f.boldest}% — the crowd said no.</div> : null}
            {beat != null ? <div className="text-[12px] text-[var(--muted)] mt-0.5">Your calls beat {beat}% of players today.</div> : null}
            {f.shotsOpened + f.shotsSealed > 0 ? (
              <div className="mt-2 pt-2 border-t border-[var(--green)]/20 text-[12px] text-[var(--muted)]">
                Called Shots · <b className="text-[var(--ink)]">{f.shotsOpened}</b> torn open · <b className="text-[var(--ink)]">{f.shotsSealed}</b> sealed forever
              </div>
            ) : null}
          </div>
        );
      })()}
      {receipts.length > 0 && (
        <>
          <Section title="Your receipts" />
          <div className="grid grid-cols-2 gap-2">
            {receipts.slice(0, 8).map((r, i) => (
              <button key={i} onClick={() => shareReceipt(r)} className="text-left bg-white border border-[var(--line)] rounded-2xl p-3.5 active:scale-[0.98] transition-transform">
                <div className="flex items-center justify-between">
                  <span className="mono text-[8px] tracking-widest uppercase text-[var(--muted)]">Receipt</span>
                  <span className="text-[8px] font-bold text-white bg-[var(--green)] rounded-full px-1.5 py-0.5">✓</span>
                </div>
                <div className="text-xl font-extrabold text-[var(--green)] mt-1.5 tabular-nums">+{fmtAmt(r.amount)}</div>
                <div className="text-[11px] font-semibold mt-0.5 leading-tight line-clamp-2">{r.q}</div>
                {r.calledAt != null && <div className="mono text-[8px] text-[var(--muted)] mt-1">called at {r.calledAt}%{r.mult ? ` · ${r.mult.toFixed(2)}×` : ""}</div>}
              </button>
            ))}
          </div>
        </>
      )}

      {grid && grid.cells.length > 0 && (
        <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Your run</div>
          <div className="mt-2.5 flex flex-wrap gap-1">{grid.cells.map((c, i) => (<RunTile key={i} kind={c} size={17} />))}</div>
          <div className="text-sm font-semibold mt-3">{grid.streak > 0 ? `Still alive — ${grid.streak}-day streak.` : "Run's over. New one starts today."}{grid.alivePct != null && grid.streak > 0 ? ` ${grid.alivePct}% of the world isn't.` : ""}</div>
          <button onClick={shareGrid} className="mt-3 h-9 px-4 rounded-lg bg-[var(--ink)] text-white text-sm font-bold">Share your grid</button>
        </div>
      )}
      {/* Responsible-play + watch-along settings. */}
      <Section title="Settings" />
      <div className="bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between">
        <div><div className="font-bold text-[15px]">Hide money</div><div className="text-[12px] text-[var(--muted)] mt-0.5">Play for the streak — blanks all amounts on screen.</div></div>
        <button onClick={toggleMute} aria-label="Toggle hide money" className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${muted ? "bg-[var(--green)]" : "bg-[var(--line)]"}`}>
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${muted ? "left-6" : "left-1"}`} />
        </button>
      </div>
      {/* K6 — install to home screen. A PWA that is never installed never gets a push. */}
      <InstallCard />

      {/* C5 — the money sound. Off by default: an app that makes noise unasked gets muted forever. */}
      <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between">
        <div><div className="font-bold text-[15px]">Stadium sound</div><div className="text-[12px] text-[var(--muted)] mt-0.5">A short chime the moment a win lands. Nothing else ever makes a sound.</div></div>
        <button onClick={() => { const next = !stadium; setStadium(next); setSoundOn(next); if (next) playPaid(); }} aria-label="Toggle stadium sound" className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${stadium ? "bg-[var(--green)]" : "bg-[var(--line)]"}`}>
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${stadium ? "left-6" : "left-1"}`} />
        </button>
      </div>
      <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between">
        <div><div className="font-bold text-[15px]">Spoiler-safe</div><div className="text-[12px] text-[var(--muted)] mt-0.5">Watching on a delay? Hides live scores &amp; match events.</div></div>
        <button onClick={toggleSpoiler} aria-label="Toggle spoiler-safe" className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${spoiler ? "bg-[var(--green)]" : "bg-[var(--line)]"}`}>
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${spoiler ? "left-6" : "left-1"}`} />
        </button>
      </div>
      {spoiler && <SpoilerDelay />}
      {pushPerm !== "unsupported" && (
        <div className="mt-2 bg-white border border-[var(--line)] rounded-2xl p-4 flex items-center justify-between gap-3">
          <div><div className="font-bold text-[15px]">Match alerts</div><div className="text-[12px] text-[var(--muted)] mt-0.5">Get pinged the second the Frozen Window opens — even with the app closed.</div></div>
          {pushPerm === "granted" ? (
            <span className="mono text-[11px] font-bold text-[var(--green)] shrink-0">✓ ON</span>
          ) : (
            <button disabled={pushBusy} onClick={enableAlerts} className="shrink-0 h-9 px-4 rounded-lg bg-[var(--ink)] text-white text-sm font-bold disabled:opacity-50">{pushBusy ? "…" : "Turn on"}</button>
          )}
        </div>
      )}

      {/* One-screen revenue model — the fee line printed from on-chain, the switch, the cap, the plan. */}
      <Section title="How GAFFER makes money" />
      <div className="bg-white border border-[var(--line)] rounded-2xl p-5">
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-bold">House cut today</span>
          <span className="text-2xl font-extrabold text-[var(--green)]">{rake === 0 ? "0%" : `${(rake / 100).toFixed(2)}%`}</span>
        </div>
        <p className="text-[13px] text-[var(--muted)] mt-2 leading-relaxed">Right now we take nothing — the entire pot goes to the people who called it right. When we do switch on a cut, it&apos;s a small rake on <b className="text-[var(--ink)]">winnings only</b> (never your stake back), hard-capped at <b className="text-[var(--ink)]">{cap}%</b> in the rules themselves — a ceiling no one can raise. Same instant, un-clawback payout, whether the cut is on or off.</p>
        <div className="grid grid-cols-3 gap-2 mt-4">
          {[["Rake", "on winnings, 0–" + cap + "%"], ["Power plays", "premium slips & boosts"], ["Squads", "private leagues"]].map(([h, s]) => (
            <div key={h} className="rounded-xl bg-[#FAFAF7] border border-[var(--line)] p-3"><div className="text-[12px] font-bold">{h}</div><div className="mono text-[9px] text-[var(--muted)] mt-1 leading-tight">{s}</div></div>
          ))}
        </div>
      </div>

      <div className="mt-6 bg-[var(--ink)] rounded-2xl p-5 text-white">
        <div className="mono text-[10px] uppercase tracking-widest text-[var(--greenb)]">Why GAFFER</div>
        <div className="text-lg font-bold mt-2">Win all you want. Paid the instant it happens. And we can prove it — every time.</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {["No ads. Ever.", "Win too much? We can't ban you.", "No house betting against you"].map((t) => (
            <span key={t} className="mono text-[10px] font-semibold text-white/85 bg-white/10 rounded-full px-2.5 py-1">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (<svg viewBox="0 0 64 64" width="24" height="24" fill="none"><circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="6.5" /><line x1="32" y1="6" x2="32" y2="58" stroke="currentColor" strokeWidth="6.5" /><circle cx="32" cy="32" r="6" fill="currentColor" /></svg>);
}
