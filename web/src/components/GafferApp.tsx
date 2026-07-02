"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserKernel } from "@/lib/kernelClient";
import { BrowserParlay } from "@/lib/parlayClient";
import { useAppWallet } from "@/lib/walletCtx";
import { getMarkets, getScores, createMarket, squad as squadApi, squadGet, settleParlay, points as pointsApi, pointsGet, streakGrid as streakGridApi, streakGridText, getNations, roundsGet, roundOpen, roundCall } from "@/lib/api";
import { prettyErr } from "@/lib/errcopy";
import { listParlays } from "@/lib/kernel";
import type { MarketView, ParlayView } from "@/lib/kernel";

const FIXTURES: Record<string, { home: string; away: string }> = {
  "17588388": { home: "USA", away: "Australia" },
  "17588316": { home: "Haiti", away: "Scotland" },
  "17588306": { home: "France", away: "Senegal" },
};
const STATWORD = ["", "goal", "goal", "booking", "booking", "red card", "red card", "corner", "corner"];
// Canonical nations a fan can fly (names match the flag map in /api/nations so standings stay consistent).
const PICK_NATIONS = [
  { name: "USA", flag: "🇺🇸" }, { name: "Brazil", flag: "🇧🇷" }, { name: "Argentina", flag: "🇦🇷" },
  { name: "France", flag: "🇫🇷" }, { name: "England", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" }, { name: "Spain", flag: "🇪🇸" },
  { name: "Mexico", flag: "🇲🇽" }, { name: "Germany", flag: "🇩🇪" }, { name: "Portugal", flag: "🇵🇹" },
  { name: "Netherlands", flag: "🇳🇱" }, { name: "Morocco", flag: "🇲🇦" }, { name: "Japan", flag: "🇯🇵" },
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
  const f = FIXTURES[m.fixtureId] || { home: "Home", away: "Away" };
  const base = m.statKey % 1000;
  const who = base % 2 === 1 ? f.home : f.away;
  return { match: `${f.home} v ${f.away}`, q: humanQ(who, base, m.comparison, m.threshold), f };
}
/** Test/nonsense pools (negative or absurd thresholds) never reach the consumer surfaces. */
function realMarket(m: MarketView) { return m.threshold >= 0 && m.threshold <= 40; }
/** One consistent money format everywhere — no bare 3-vs-2-decimal drift, no jargon unit. */
const fmtAmt = (n: number) => Number(n || 0).toFixed(2);
const day = () => new Date().toISOString().slice(0, 10);
const EXPLORER = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const DEV = process.env.NEXT_PUBLIC_GAFFER_DEV === "1"; // dev/demo controls (spin-up pool, manual settle) — OPT-IN only; consumer builds never show them

// Parimutuel projection: if your side wins, payout = potAfter × yourStake / sideAfter.
function projection(m: MarketView, side: number, stakeSol: number) {
  const yes = Number(m.yesTotal) / 1e9, no = Number(m.noTotal) / 1e9;
  const sideNow = side === 1 ? yes : no;
  const potAfter = yes + no + stakeSol;
  const sideAfter = sideNow + stakeSol;
  const payout = sideAfter > 0 ? (potAfter * stakeSol) / sideAfter : stakeSol;
  return { yes, no, potNow: yes + no, payout, multiple: stakeSol > 0 ? payout / stakeSol : 0 };
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
  const [detail, setDetail] = useState<MarketView | null>(null);
  const [stake, setStake] = useState(0.05);
  const [paid, setPaid] = useState<{ amount: number; q: string; sig?: string; when: string } | null>(null);
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
  const [slip, setSlip] = useState<{ market: MarketView; q: string }[]>([]);
  const [slipOpen, setSlipOpen] = useState(false);
  const [parlays, setParlays] = useState<ParlayView[]>([]);
  const [positions, setPositions] = useState<{ market: string; side: number; amount: number; claimed: boolean }[]>([]);
  const [frozen, setFrozen] = useState<{ active: any; settled: any }>({ active: null, settled: null });
  const [frozenSeen, setFrozenSeen] = useState<string>(""); // last settled round id the user dismissed
  const parlay = useMemo(() => (wallet ? new BrowserParlay(wallet) : null), [wallet]);
  const activeFixture = markets.length ? Number(markets[0].fixtureId) : 17588388;

  const userId = address;
  const flash = (msg: string, kind: "ok" | "err" = "ok") => { setToast({ msg, kind }); setTimeout(() => setToast(null), 3200); };

  const refresh = useCallback(async () => {
    try {
      const [mk, pl] = await Promise.all([getMarkets(), listParlays()]);
      setMarkets(mk); setParlays(pl);
      if (kernel) { setBal(await kernel.balanceSol()); setPositions(await kernel.myPositions()); }
    } catch {
      // Keep the last-known-good view rather than a stuck spinner; the next tick retries.
    } finally { setLoading(false); }
  }, [kernel]);

  useEffect(() => {
    const today = day();
    setFreePicked(localStorage.getItem("gaffer_freeday") === today);
    setNation(localStorage.getItem("gaffer_nation") || "USA");
    setUserName(localStorage.getItem("gaffer_name") || "You");
    setSquadCode(localStorage.getItem("gaffer_squad") || "");
    const sp = new URLSearchParams(window.location.search).get("squad");
    if (sp) {
      const code = sp.toUpperCase(); const inSquad = localStorage.getItem("gaffer_squad");
      setPendingJoin(code);
      if (!inSquad) setTab("squad");
      else if (inSquad !== code) { setTab("squad"); flash(`Leave your squad first to join ${code}`, "err"); }
    }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);

  // Points, streak and freezes are server-authoritative (KILL-2): read them from the ledger, never
  // trust or write a local total. Refreshes whenever the wallet (userId) resolves or after a grant.
  const refreshPoints = useCallback(async () => {
    if (!userId) return;
    const r = await pointsGet(userId);
    if (r) { setPoints(r.points); setStreak(r.streak); setFreezes(r.freezes); if (r.token) localStorage.setItem("gaffer_ptoken", r.token); }
  }, [userId]);
  useEffect(() => { refreshPoints(); }, [refreshPoints]);
  // The per-user token guards every points grant (so no one can mint points for another id).
  const pTok = () => (typeof window !== "undefined" ? localStorage.getItem("gaffer_ptoken") || "" : "");

  const refreshSquad = useCallback(async () => {
    if (!squadCode) return;
    const r = await squadGet(squadCode);
    if (r?.squad) setSquadData(r.squad);
  }, [squadCode]);
  useEffect(() => {
    if (!squadCode) { setSquadData(null); return; }
    refreshSquad();
    const t = setInterval(refreshSquad, 5000);
    return () => clearInterval(t);
  }, [squadCode, refreshSquad]);

  // THE FROZEN WINDOW — poll for a live round on the fixture. When one fires, every squad member's phone
  // flips to the same takeover at the same second; the reveal lingers until dismissed.
  useEffect(() => {
    let on = true;
    const tick = async () => { const r = await roundsGet(activeFixture, squadCode || null); if (on) setFrozen(r); };
    tick(); const t = setInterval(tick, 2000);
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

  const freePick = async (side: "yes" | "no") => {
    if (freePicked) return;
    if (!userId) { if (mode === "privy") login(); return; }
    let tok = pTok();
    if (!tok) { const g = await pointsGet(userId); if (g?.token) { localStorage.setItem("gaffer_ptoken", g.token); tok = g.token; } }
    setFreePicked(true); localStorage.setItem("gaffer_freeday", day());
    // The server records the pick (side + fixture, for later grading), grants the entry points, and
    // returns the derived streak. The token proves this grant is for THIS user.
    const r = await pointsApi("free_pick", { userId, token: tok, side, fixtureId: 17588388, quest: "Goal before half-time? USA v Australia", squadCode: squadCode || null });
    if (r) {
      setPoints(r.points); setStreak(r.streak); setFreezes(r.freezes);
      if (squadCode) refreshSquad();
      flash(`Locked: ${side.toUpperCase()} — streak ${r.streak} 🔥`);
    } else { setFreePicked(false); flash("Couldn't lock your pick", "err"); }
  };
  const fund = async () => {
    if (!address) { if (mode === "privy") login(); return; }
    setBusy("fund");
    try {
      if (mode === "privy") { await onramp(); flash("Add funds"); } // production: Privy fiat on-ramp
      else { const r = await ctxFund(); if (r?.error) throw new Error(r.error); flash(r?.funded ? "Added funds" : "Already funded"); } // dev: faucet
      await refresh();
    } catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };
  const spinUp = async () => {
    setBusy("spin");
    try { const r = await createMarket({ fixtureId: 17588388, statKey: 1, period: 4, threshold: 0, comparison: 0 }); if (r.error) throw new Error(r.error); flash("Pool live"); await refresh(); }
    catch (e: any) { flash(prettyErr(e, "neutral"), "err"); } finally { setBusy(null); }
  };
  const doStake = async () => {
    if (!sheet) return;
    if (!kernel) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return; }
    setBusy("stake");
    try {
      const sig = await kernel.join(sheet.m.pubkey, sheet.side, stake);
      // Points are granted server-side ONLY after verifying this exact tx on-chain, signed by the user.
      pointsApi("stake", { userId, token: pTok(), sig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      if (squadCode) squadApi("call", { code: squadCode, userId, token: sqTok(), name: userName, market: sheet.m.pubkey, side: sheet.side, q: label(sheet.m).q }).then((r) => r?.squad && setSquadData(r.squad));
      flash(`Staked ${stake} on ${sheet.side === 1 ? "YES" : "NO"}`); setSheet(null); await refresh();
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
      // Side-aware: figure out which of the user's positions are actually claimable for this
      // market's resolution. SETTLED_YES → only a YES position wins; VOID → either side refunds.
      const [posYes, posNo] = await Promise.all([kernel.myPosition(m.pubkey, 1), kernel.myPosition(m.pubkey, 2)]);
      const targets: number[] = [];
      if (m.status === 1) { if (posYes && !posYes.claimed) targets.push(1); }
      else if (m.status === 2) { if (posYes && !posYes.claimed) targets.push(1); if (posNo && !posNo.claimed) targets.push(2); }
      if (targets.length === 0) { flash(m.status === 1 ? "That side didn't win" : "Nothing to claim here", "err"); setBusy(null); return; }
      const pot = (Number(m.yesTotal) + Number(m.noTotal)) / 1e9;
      const yes = Number(m.yesTotal) / 1e9 || 1;
      let lastSig = "", total = 0;
      for (const side of targets) {
        const pos = side === 1 ? posYes : posNo;
        lastSig = await kernel.claim(m.pubkey, side);
        total += m.status === 1 ? pot * ((pos?.amount || 0) / yes) : (pos?.amount || 0);
      }
      if (m.status === 1) {
        setPaid({ amount: total, q: label(m).q, sig: lastSig, when: new Date().toLocaleString() });
        pointsApi("win", { userId, token: pTok(), sig: lastSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      } else { flash(`Refunded ${total.toFixed(3)}`); }
      setDetail(null); await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };

  const member = (nm?: string) => ({ id: userId, name: nm || userName, nation });
  const setName = (nm: string) => { setUserName(nm); localStorage.setItem("gaffer_name", nm); };
  const sqTok = () => (typeof window !== "undefined" ? localStorage.getItem("gaffer_squad_token") || "" : "");
  const syncSquad = (patch: any) => { if (squadCode && userId) squadApi("sync", { code: squadCode, userId, token: sqTok(), patch }).then((r) => r?.squad && setSquadData(r.squad)); };
  const createMySquad = async (name: string, nm?: string) => { if (nm) setName(nm); const r = await squadApi("create", { name, member: member(nm) }); if (r?.squad) { setSquadCode(r.squad.code); localStorage.setItem("gaffer_squad", r.squad.code); if (r.token) localStorage.setItem("gaffer_squad_token", r.token); setSquadData(r.squad); flash("Squad created — share the code"); } };
  const joinByCode = async (code: string, nm?: string) => { if (nm) setName(nm); const r = await squadApi("join", { code, member: member(nm) }); if (r?.squad) { setSquadCode(r.squad.code); localStorage.setItem("gaffer_squad", r.squad.code); if (r.token) localStorage.setItem("gaffer_squad_token", r.token); setSquadData(r.squad); setPendingJoin(""); flash("Joined " + r.squad.name); } else flash("Squad not found", "err"); };
  const postBanter = async (text: string) => { const r = await squadApi("post", { code: squadCode, userId, name: userName, text, token: sqTok() }); if (r?.squad) setSquadData(r.squad); };
  const reactTo = async (msgId: string, emoji: string) => { const r = await squadApi("react", { code: squadCode, msgId, emoji, userId, token: sqTok() }); if (r?.squad) setSquadData(r.squad); };
  const copyCall = (marketStr: string, side: number) => { const m = markets.find((x) => x.pubkey === marketStr); if (m && m.status === 0) setSheet({ m, side }); else flash("That pool has closed", "err"); };
  const leaveSquad = () => { setSquadCode(""); setSquadData(null); localStorage.removeItem("gaffer_squad"); localStorage.removeItem("gaffer_squad_token"); flash("Left the squad"); };

  // ── Multi-call slip (parlay): all calls must land (Power). One match per slip in v1. ──
  const addToSlip = (m: MarketView) => {
    if (m.status !== 0) { flash("That pool has closed", "err"); return; }
    if (slip.find((s) => s.market.pubkey === m.pubkey)) { flash("Already in your slip"); return; }
    if (slip.length > 0 && slip[0].market.fixtureId !== m.fixtureId) { flash("One match per slip for now", "err"); return; }
    if (slip.length >= 8) { flash("Max 8 calls in a slip", "err"); return; }
    setSlip([...slip, { market: m, q: label(m).q }]); flash("Added to your slip");
  };
  const removeFromSlip = (pubkey: string) => setSlip(slip.filter((s) => s.market.pubkey !== pubkey));
  const placeSlip = async (stakeSol: number) => {
    if (slip.length < 2) { flash("Add at least 2 calls to a slip", "err"); return; }
    if (!parlay) { if (mode === "privy") login(); else flash("One sec — getting you set up.", "err"); return; }
    setBusy("slip");
    try {
      // Power only (all-must-land) in v1. Flex (insured partial payout) needs kernel partial-payout — deferred (see BUILD-TODO B).
      const fixtureId = Number(slip[0].market.fixtureId);
      const legs = slip.map((s) => ({ statKey: s.market.statKey, period: s.market.period, threshold: s.market.threshold, comparison: s.market.comparison }));
      const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
      const pk = await parlay.create(fixtureId, legs, expiry); // user-signed + rent-funded (not the server keypair)
      const joinSig = await parlay.join(pk, 1, stakeSol); // back YES = every call lands
      pointsApi("stake", { userId, token: pTok(), sig: joinSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      flash(`Slip placed — ${slip.length} calls, all must land`); setSlip([]); setSlipOpen(false); await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };
  const fadeParlayFn = async (p: ParlayView) => {
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
        setPaid({ amount: total, q: `${p.legs.length}-call slip`, sig: lastSig, when: new Date().toLocaleString() });
        pointsApi("win", { userId, token: pTok(), sig: lastSig, squadCode: squadCode || null }).then((r) => { if (r?.points != null) setPoints(r.points); });
      } else flash(`Refunded ${total.toFixed(3)}`);
      await refresh();
    } catch (e: any) { flash(prettyErr(e), "err"); } finally { setBusy(null); }
  };

  const short = address ? address.slice(0, 4) + "…" + address.slice(-4) : "…";
  const shared = { markets, label, busy, setSheet, settle, claim, setDetail };

  return (
    <div className="mx-auto max-w-[440px] flex flex-col" style={{ minHeight: "100dvh" }}>
      <header className="px-5 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <div><div className="text-[19px] font-extrabold tracking-tight leading-none">gaffer.</div><div className="mono text-[9px] tracking-widest uppercase text-[var(--muted)] mt-0.5">World Cup</div></div>
        </div>
        <button onClick={() => setTab("you")} className="flex items-center gap-2 bg-[var(--ink)] text-white rounded-full pl-2 pr-3 py-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--greenb)] gf-pulse" /><span className="text-[15px] font-bold">{streak}</span>
          <span className="mono text-[8px] leading-tight text-[#9CA3AF]">DAY<br />STREAK</span>
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-5 pb-28">
        {tab === "today" && <Today {...shared} loading={loading} spinUp={spinUp} streak={streak} freezes={freezes} freePicked={freePicked} freePick={freePick} addToSlip={addToSlip} parlays={parlays} positions={positions} settleParlayFn={settleParlayFn} claimParlayFn={claimParlayFn} fadeParlayFn={fadeParlayFn} />}
        {tab === "squad" && <Squad userId={userId} userName={userName} setName={setName} nation={nation} setNation={(n: string) => { setNation(n); localStorage.setItem("gaffer_nation", n); syncSquad({ nation: n }); }} squadCode={squadCode} squadData={squadData} createMySquad={createMySquad} joinByCode={joinByCode} postBanter={postBanter} reactTo={reactTo} copyCall={copyCall} leaveSquad={leaveSquad} pendingJoin={pendingJoin} flash={flash} />}
        {tab === "live" && <Live fixtureId={activeFixture} onFreeze={() => frozenTrigger("freeze")} onBlackout={() => frozenTrigger("blackout")} />}
        {tab === "cash" && <Cash bal={bal} fund={fund} short={short} positions={positions} {...shared} />}
        {tab === "you" && <You short={short} streak={streak} bal={bal} points={points} nation={nation} userName={userName} userId={userId} flash={flash} />}
      </main>

      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[440px] bg-white/90 backdrop-blur border-t border-[var(--line)] px-4 py-3 pb-6 flex justify-around">
        {([["today", "Today"], ["squad", "Squad"], ["live", "Live"], ["cash", "Cash"], ["you", "You"]] as const).map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)} className={`mono text-[10px] tracking-wide font-semibold ${tab === k ? "text-[var(--ink)]" : "text-[#9CA3AF]"}`}>{t}</button>
        ))}
      </nav>

      {sheet && <CallSheet sheet={sheet} setSheet={setSheet} stake={stake} setStake={setStake} doStake={doStake} busy={busy} />}
      {detail && <PoolDetail m={detail} close={() => setDetail(null)} setSheet={setSheet} settle={settle} claim={claim} busy={busy} kernel={kernel} />}
      {(frozen.active || frozenReveal) && (
        <FrozenWindow
          round={frozen.active || frozenReveal}
          userId={userId}
          onCall={frozenCall}
          onDismiss={() => { const id = (frozen.active || frozenReveal)?.id; if (id) setFrozenSeen(id); refreshPoints(); if (squadCode) refreshSquad(); }}
          onPinLore={(text: string) => { if (squadCode) postBanter(`📌 ${text}`); }}
        />
      )}
      {paid && <PaidOverlay paid={paid} close={() => setPaid(null)} flash={flash} />}
      {slip.length > 0 && !slipOpen && <button onClick={() => setSlipOpen(true)} className="fixed bottom-24 left-1/2 -translate-x-1/2 z-30 px-5 py-3 rounded-full bg-[var(--green)] text-white font-bold shadow-lg">Slip · {slip.length} call{slip.length === 1 ? "" : "s"} →</button>}
      {slipOpen && <SlipSheet slip={slip} removeFromSlip={removeFromSlip} placeSlip={placeSlip} close={() => setSlipOpen(false)} busy={busy} />}
      {toast && <div className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-semibold text-white ${toast.kind === "ok" ? "bg-[var(--ink)]" : "bg-red-600"}`}>{toast.msg}</div>}
    </div>
  );
}

function Today({ markets, loading, label, busy, spinUp, setSheet, settle, claim, setDetail, streak, freezes, freePicked, freePick, addToSlip, parlays, positions = [], settleParlayFn, claimParlayFn, fadeParlayFn }: any) {
  // Only surface pools that are genuinely OPEN — status live, before the lock cut-off (KILL-1), and a
  // real market (test pools with absurd thresholds never reach a fan). `nowSec` ticks in an effect so
  // the render stays pure (no Date.now() in the render body).
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10000); return () => clearInterval(t); }, []);
  const open = markets.filter((m: MarketView) => m.status === 0 && Number(m.lockTs) > nowSec && realMarket(m));
  // "Paid out" shows only settled pools YOU were in and can still collect.
  const held = (mkt: string) => positions.some((p: any) => p.market === mkt && !p.claimed && p.amount > 0 && p.side === 1);
  const settled = markets.filter((m: MarketView) => m.status === 1 && realMarket(m) && held(m.pubkey));
  return (
    <div>
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white relative overflow-hidden">
        <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full" style={{ background: "radial-gradient(circle, rgba(5,150,105,.5), transparent 70%)" }} />
        <div className="relative">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Today&apos;s free call</div>
          <p className="text-[19px] font-bold tracking-tight mt-3">Goal before half-time? <span className="text-[#9CA3AF] font-normal">USA v Australia</span></p>
          {!freePicked ? (
            <div className="flex gap-2 mt-4">
              <button onClick={() => freePick("yes")} className="flex-1 h-12 rounded-xl bg-white text-[var(--ink)] font-bold">Yes</button>
              <button onClick={() => freePick("no")} className="flex-1 h-12 rounded-xl bg-[#1d1d1f] border border-[#2c2c2e] font-bold">No</button>
            </div>
          ) : (
            <div className="flex items-end gap-3 mt-4"><div className="text-5xl font-extrabold leading-none">{streak}</div><div className="pb-1 text-[15px] font-bold leading-tight">day streak<br /><span className="text-[var(--greenb)]">still alive</span></div></div>
          )}
          <div className="flex items-center gap-1.5 mt-3">
            {Array.from({ length: 3 }).map((_, i) => (<span key={i} className={`text-sm ${i < freezes ? "" : "opacity-25 grayscale"}`}>🧊</span>))}
            <span className="mono text-[10px] text-[#9CA3AF] ml-1">{freezes} freeze{freezes === 1 ? "" : "s"} · miss a day, keep your run</span>
          </div>
          <p className="text-[12px] text-[#9CA3AF] mt-2">Free. No sign-up. Keep your run — play for real when you&apos;re ready.</p>
        </div>
      </div>

      {DEV && <button disabled={busy === "spin"} onClick={spinUp} className="mt-4 w-full h-12 rounded-2xl border-2 border-dashed border-[var(--line)] text-[var(--muted)] font-semibold disabled:opacity-50">{busy === "spin" ? "Spinning up…" : "+ Spin up a pool (USA v Australia)"}</button>}

      <Section title="Open pools" />
      {loading && open.length === 0 && <div className="text-sm text-[var(--muted)] py-6 text-center">Loading today&apos;s pools…</div>}
      {!loading && open.length === 0 && <div className="text-sm text-[var(--muted)] py-6 text-center">No pools open right now — check back at kick-off.</div>}
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

      {parlays.length > 0 && <Section title="Slips · all must land" />}
      {parlays.slice(0, 5).map((p: ParlayView) => (
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

      {settled.length > 0 && <Section title="Ready to collect" />}
      {settled.slice(0, 6).map((m: MarketView) => (
        <Card key={m.pubkey} m={m} label={label} onOpen={() => setDetail(m)}>
          <button disabled={!!busy} onClick={() => claim(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{busy === "claim:" + m.pubkey ? "collecting…" : "Collect your winnings →"}</button>
        </Card>
      ))}
    </div>
  );
}

function Card({ m, label, children, onOpen }: any) {
  const l = label(m);
  const pot = ((Number(m.yesTotal) + Number(m.noTotal)) / 1e9).toFixed(2);
  return (
    <div className="bg-white border border-[var(--line)] rounded-2xl p-4 mb-2.5">
      <button onClick={onOpen} className="w-full text-left">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] uppercase tracking-wide text-[#9CA3AF]">{l.match}</span>
          <span className={`mono text-[10px] ${m.status === 1 ? "text-[var(--green)]" : "text-[var(--muted)]"}`}>{m.statusLabel} · {pot}</span>
        </div>
        <div className="text-[17px] font-bold tracking-tight mt-1">{l.q}?</div>
      </button>
      {children}
    </div>
  );
}

function Section({ title }: { title: string }) { return <div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF] mt-6 mb-2">{title}</div>; }

function CallSheet({ sheet, setSheet, stake, setStake, doStake, busy }: any) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end" onClick={() => setSheet(null)}>
      <div className="w-full bg-white rounded-t-3xl p-6 pb-9 gf-pop relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={() => setSheet(null)} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">{label(sheet.m).match}</div>
        <h3 className="text-2xl font-bold tracking-tight mt-1">{label(sheet.m).q}?</h3>
        <div className="flex gap-2 mt-5">{[1, 2].map((s) => (<button key={s} onClick={() => setSheet({ ...sheet, side: s })} className={`flex-1 h-12 rounded-xl font-bold ${sheet.side === s ? "bg-[var(--ink)] text-white" : "bg-white border border-[var(--ink)]"}`}>{s === 1 ? "YES" : "NO"}</button>))}</div>
        <div className="mt-5 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Stake</div>
        <div className="flex gap-2 mt-2">{[0.02, 0.05, 0.1].map((v) => (<button key={v} onClick={() => setStake(v)} className={`flex-1 h-11 rounded-xl font-semibold ${stake === v ? "border-2 border-[var(--green)] text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{v}</button>))}</div>
        {(() => { const p = projection(sheet.m, sheet.side, stake); return (
          <div className="mt-4 rounded-2xl bg-[#FAFAF7] border border-[var(--line)] p-4">
            <div className="flex justify-between mono text-[10px] text-[#9CA3AF]"><span>POOL NOW {p.potNow.toFixed(2)}</span><span>YES {p.yes.toFixed(2)} · NO {p.no.toFixed(2)}</span></div>
            <div className="mt-2 flex items-end justify-between">
              <span className="text-sm font-semibold text-[var(--muted)]">If it lands you win</span>
              <span className="text-2xl font-extrabold text-[var(--green)]">~{fmtAmt(p.payout)}</span>
            </div>
            <div className="text-right mono text-[10px] text-[var(--muted)]">{p.multiple.toFixed(2)}× your stake</div>
            {p.multiple < 1.06 && <div className="mt-1 text-[11px] text-[var(--muted)]">Be first — your payout grows as others back the other side.</div>}
          </div>
        ); })()}
        <button disabled={busy === "stake"} onClick={doStake} className="mt-4 w-full h-14 rounded-2xl bg-[var(--ink)] text-white text-lg font-bold disabled:opacity-50">{busy === "stake" ? "Locking in…" : `Lock in ${stake} on ${sheet.side === 1 ? "YES" : "NO"}`}</button>
        <p className="text-center text-xs text-[#9CA3AF] mt-3">✓ Yours the moment the result&apos;s in · no house · your money back if the match is called off.</p>
      </div>
    </div>
  );
}

function SlipSheet({ slip, removeFromSlip, placeSlip, close, busy }: any) {
  const [stake, setStake] = useState(0.05);
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end" onClick={close}>
      <div className="w-full bg-white rounded-t-3xl p-6 pb-9 gf-pop max-h-[88%] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={close} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="flex items-center justify-between">
          <h3 className="text-2xl font-bold tracking-tight">Your slip</h3>
          <span className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">{slip.length} call{slip.length === 1 ? "" : "s"} · all must land</span>
        </div>
        <div className="mt-4 space-y-2">
          {slip.map((s: any) => (
            <div key={s.market.pubkey} className="flex items-center gap-2 bg-[#FAFAF7] border border-[var(--line)] rounded-xl p-3">
              <span className="flex-1 text-sm font-semibold">{s.q}?</span>
              <button onClick={() => removeFromSlip(s.market.pubkey)} className="mono text-[11px] text-[var(--muted)]">remove</button>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-2xl bg-[var(--ink)] text-white p-4">
          <div className="mono text-[10px] uppercase tracking-widest text-[var(--greenb)]">If they ALL land</div>
          <div className="text-[13px] text-white/90 mt-1">You split the whole pot with everyone who also backed all {slip.length} to land — and it grows every time someone bets the slip busts. One miss and the slip is off.</div>
        </div>
        <div className="mt-4 mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Stake</div>
        <div className="flex gap-2 mt-2">{[0.02, 0.05, 0.1].map((v) => (<button key={v} onClick={() => setStake(v)} className={`flex-1 h-11 rounded-xl font-semibold ${stake === v ? "border-2 border-[var(--green)] text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{v}</button>))}</div>
        <button disabled={busy === "slip" || slip.length < 2} onClick={() => placeSlip(stake)} className="mt-4 w-full h-14 rounded-2xl bg-[var(--green)] text-white text-lg font-bold disabled:opacity-50">{busy === "slip" ? "Placing…" : slip.length < 2 ? "Add 2+ calls" : `Place slip · ${stake}`}</button>
        <p className="text-center text-xs text-[#9CA3AF] mt-3">All calls in one match · collect the moment the last one lands.</p>
      </div>
    </div>
  );
}

function PoolDetail({ m, close, setSheet, settle, claim, busy, kernel }: any) {
  const l = label(m); const yes = Number(m.yesTotal) / 1e9; const no = Number(m.noTotal) / 1e9; const pot = yes + no;
  const [posY, setPosY] = useState<any>(null);
  const [posN, setPosN] = useState<any>(null);
  useEffect(() => { if (kernel) { kernel.myPosition(m.pubkey, 1).then(setPosY); kernel.myPosition(m.pubkey, 2).then(setPosN); } }, [kernel, m.pubkey]);
  const mine = [posY?.amount > 0 ? { side: "YES", ...posY } : null, posN?.amount > 0 ? { side: "NO", ...posN } : null].filter(Boolean) as any[];
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end" onClick={close}>
      <div className="w-full bg-white rounded-t-3xl p-6 pb-9 gf-pop max-h-[88%] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto w-10 h-1.5 rounded-full bg-[var(--line)] mb-4" />
        <button onClick={close} aria-label="Close" className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#FAFAF7] border border-[var(--line)] text-[var(--muted)] flex items-center justify-center">✕</button>
        <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">{l.match} · {m.statusLabel}</div>
        <h3 className="text-2xl font-bold tracking-tight mt-1">{l.q}?</h3>
        <div className="mt-4 bg-[var(--ink)] rounded-2xl p-5 text-white">
          <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">In the pot</div>
          <div className="text-4xl font-extrabold mt-1">{pot.toFixed(2)}</div>
          <div className="text-[12px] text-[#9CA3AF] mt-2">The whole pot splits between everyone who calls it right — no house, no cut.</div>
          <div className="flex gap-4 mt-3 text-sm"><span className="text-[var(--greenb)]">YES {yes.toFixed(2)}</span><span className="text-[#9CA3AF]">NO {no.toFixed(2)}</span></div>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          {[1, 2].map((s) => { const mm = sideMultiple(m, s); return (
            <div key={s} className="rounded-xl border border-[var(--line)] p-3 text-center">
              <div className="mono text-[10px] text-[#9CA3AF]">{s === 1 ? "YES" : "NO"} pays now</div>
              <div className="text-xl font-extrabold">{mm ? mm.toFixed(2) + "×" : "be first"}</div>
            </div>
          ); })}
        </div>
        {mine.map((p) => (<div key={p.side} className="mt-3 text-sm text-[var(--muted)]">Your call: <b className="text-[var(--ink)]">{fmtAmt(p.amount)}</b> on {p.side}{p.claimed ? " · collected" : ""}</div>))}
        {m.status === 0 ? (
          <>
            <div className="flex gap-2 mt-5"><button onClick={() => { close(); setSheet({ m, side: 1 }); }} className="flex-1 h-12 rounded-xl bg-[var(--ink)] text-white font-bold">Back YES</button><button onClick={() => { close(); setSheet({ m, side: 2 }); }} className="flex-1 h-12 rounded-xl bg-white border border-[var(--ink)] font-bold">Back NO</button></div>
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

function PaidOverlay({ paid, close, flash }: any) {
  const share = async () => {
    const text = `I called it on GAFFER — +${fmtAmt(paid.amount)} on "${paid.q}". Paid the second it happened. 🟢`;
    try {
      if ((navigator as any).share) await (navigator as any).share({ text });
      else { await navigator.clipboard.writeText(text); flash?.("Receipt copied — paste it in the chat"); }
    } catch { /* dismissed */ }
  };
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center text-white px-7" style={{ background: "radial-gradient(120% 90% at 50% 30%, #047857, #064e3b)" }}>
      <div className="absolute top-[18%] w-52 h-52 rounded-full border-2 border-white/30 gf-ring" />
      {/* Proof-of-Payout card */}
      <div className="relative gf-pop w-full max-w-xs bg-white text-[var(--ink)] rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Receipt</span>
          <span className="text-[9px] font-bold text-white bg-[var(--green)] rounded-full px-2 py-0.5">✓ VERIFIED</span>
        </div>
        <div className="w-16 h-16 mx-auto rounded-full bg-[var(--green)] flex items-center justify-center text-white text-3xl font-black mt-4">✓</div>
        <div className="mono text-[10px] tracking-[0.25em] uppercase text-[var(--muted)] mt-4 text-center">You called it</div>
        <div className="text-[54px] font-extrabold tracking-tight leading-none mt-1 text-center text-[var(--green)] gf-roll">+{fmtAmt(paid.amount)}</div>
        <div className="text-center text-[var(--muted)] text-sm">it&apos;s yours</div>
        <div className="text-center text-base font-bold mt-3">{paid.q}</div>
        <div className="text-center mono text-[10px] text-[#9CA3AF] mt-1">{paid.when}</div>
        <div className="mt-4 rounded-xl bg-[#FAFAF7] border border-[var(--line)] p-2.5 text-center text-[12px] font-semibold">🔒 It&apos;s yours. No one can take it back.</div>
        {paid.sig && <a href={EXPLORER(paid.sig)} target="_blank" rel="noreferrer" className="block text-center mono text-[10px] text-[#9CA3AF] mt-3 underline">see the receipt ›</a>}
      </div>
      <div className="relative mt-6 w-full max-w-xs flex gap-2">
        <button onClick={share} className="flex-1 py-3.5 rounded-2xl bg-white/15 text-white font-bold">Share</button>
        <button onClick={close} className="flex-1 py-3.5 rounded-2xl bg-white text-[#047857] font-bold">Done</button>
      </div>
    </div>
  );
}

function Squad({ userId, userName, setName, nation, setNation, squadCode, squadData, createMySquad, joinByCode, postBanter, reactTo, copyCall, leaveSquad, pendingJoin, flash }: any) {
  const [view, setView] = useState<"squad" | "nations">("squad");
  const [sqName, setSqName] = useState("");
  const [code, setCode] = useState(pendingJoin || "");
  const [handle, setHandle] = useState(userName === "You" ? "" : userName);
  const [msg, setMsg] = useState("");
  const [nations, setNations] = useState<{ name: string; flag: string; pts: number; fans: number }[]>([]);
  useEffect(() => { if (pendingJoin) setCode(pendingJoin); }, [pendingJoin]);
  useEffect(() => { if (view === "nations") getNations().then(setNations); }, [view]);

  const toggle = (
    <div className="flex gap-2 mt-1">
      {(["squad", "nations"] as const).map((v) => (<button key={v} onClick={() => setView(v)} className={`flex-1 h-10 rounded-xl font-bold text-sm ${view === v ? "bg-[var(--ink)] text-white" : "bg-white border border-[var(--line)]"}`}>{v === "squad" ? (squadData?.name || "Squad") : "Nations"}</button>))}
    </div>
  );
  const Nations = (
    <>
      <Section title={`Fly your flag · you fly ${nation}`} />
      <div className="flex flex-wrap gap-2">
        {PICK_NATIONS.map((n) => (
          <button key={n.name} onClick={() => { setNation(n.name); flash(`Now flying ${n.name}`); getNations().then(setNations); }} className={`h-10 px-3 rounded-xl border text-sm font-semibold flex items-center gap-1.5 ${n.name === nation ? "border-[var(--green)] bg-[var(--green)]/10" : "border-[var(--line)] bg-white"}`}><span className="text-base">{n.flag}</span>{n.name}</button>
        ))}
      </div>
      <Section title="Nation board · live" />
      {nations.length === 0 ? (
        <div className="bg-white border border-[var(--line)] rounded-2xl p-5 text-sm text-[var(--muted)] text-center">Standings build as fans earn points. You&apos;re first in — pick your flag above.</div>
      ) : (
        <div className="bg-white border border-[var(--line)] rounded-2xl overflow-hidden">
          {nations.map((n, i) => (<div key={n.name} className={`w-full flex items-center gap-3 px-4 py-3 border-b border-[#F1F1EF] text-left ${n.name === nation ? "bg-[#FAFAF7]" : ""}`}><span className="mono text-xs w-4 text-[var(--muted)]">{i + 1}</span><span className="text-xl">{n.flag}</span><span className={`flex-1 ${n.name === nation ? "font-bold" : "font-medium"}`}>{n.name}{n.name === nation ? " · you" : ""}</span><span className="mono text-[10px] text-[var(--muted)] mr-2">{n.fans} fan{n.fans === 1 ? "" : "s"}</span><span className="mono text-sm">{n.pts}</span></div>))}
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
  const medal = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`);
  const REACTS = ["🔥", "👏", "🤣", "🐐"]; // must stay within the server-side whitelist
  const share = async () => { const text = `Join my GAFFER squad "${sq.name}" 🟢 ${link}`; try { if ((navigator as any).share) await (navigator as any).share({ text }); else { await navigator.clipboard.writeText(link); flash("Invite link copied"); } } catch { /* dismissed */ } };

  return (
    <div>
      {toggle}
      {/* shareable standings card (screenshot it into the chat) */}
      <div className="mt-2 rounded-3xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#0e0e0f,#10261d)" }}>
        <div className="flex items-center justify-between"><span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{sq.name} · matchday</span><span className="mono text-[10px] text-[#9CA3AF]">{members.length} in</span></div>
        <div className="mt-3 space-y-1.5">
          {members.slice(0, 3).map((m, i) => (<div key={m.id} className="flex items-center gap-2"><span className="w-5 text-center">{medal(i)}</span><span className={`flex-1 ${m.id === userId ? "font-extrabold text-[var(--greenb)]" : "font-semibold"}`}>{m.name}</span><span className="mono text-sm">{m.points}</span></div>))}
        </div>
        {myRank > 3 && <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2"><span className="w-5 text-center">{myRank}</span><span className="flex-1 font-extrabold text-[var(--greenb)]">{me?.name || "You"}</span><span className="mono text-sm">{me?.points || 0}</span></div>}
        <div className="mt-3 mono text-[9px] text-[#6B7280]">gaffer · call it, get paid</div>
      </div>
      <div className="flex gap-2 mt-2">
        <button onClick={share} className="flex-1 h-11 rounded-xl bg-[var(--ink)] text-white font-bold text-sm">Share / invite</button>
        <button onClick={() => { navigator.clipboard.writeText(sq.code); flash(`Code ${sq.code} copied`); }} className="px-4 h-11 rounded-xl bg-white border border-[var(--line)] mono font-bold text-sm">{sq.code}</button>
      </div>

      <div className={`mt-3 rounded-xl p-3 text-sm font-semibold ${earned ? "bg-[var(--green)]/10 text-[var(--green)]" : "bg-[#FAFAF7] border border-[var(--line)]"}`}>{earned ? "🏅 Skipper badge earned — 250 pts and climbing." : `🎯 ${BADGE - (me?.points || 0)} pts to the Skipper badge (you: ${me?.points || 0})`}</div>
      {members.length < 6 && <p className="mono text-[11px] text-[var(--muted)] mt-2">{members.length}/15 · best squads are 6–15 — invite a few more for live banter.</p>}

      <Section title="Leaderboard · live" />
      <div className="bg-white border border-[var(--line)] rounded-2xl overflow-hidden">
        {members.map((m, i) => (<div key={m.id} className={`flex items-center gap-3 px-4 py-3 border-b border-[#F1F1EF] ${m.id === userId ? "bg-[#FAFAF7]" : ""}`}><span className="mono text-xs w-5 text-[var(--muted)]">{medal(i)}</span><span className={`w-7 h-7 rounded-full ${m.id === userId ? "bg-[var(--ink)]" : "bg-[var(--green)]"} text-white text-[11px] font-bold flex items-center justify-center`}>{(m.name[0] || "?").toUpperCase()}</span><span className={`flex-1 ${m.id === userId ? "font-bold" : "font-medium"}`}>{m.name}{m.id === userId ? " (you)" : ""}</span>{m.streak > 0 && <span className="mono text-[10px] text-[var(--muted)]">{m.streak}🔥</span>}<span className="mono text-sm font-semibold">{m.points}</span></div>))}
      </div>

      <div className="flex items-center justify-between mt-6 mb-2"><div className="mono text-[10px] tracking-widest uppercase text-[#9CA3AF]">Group feed</div><button onClick={leaveSquad} className="mono text-[10px] text-[var(--muted)] underline">leave</button></div>
      <div className="space-y-2">
        {[...sq.feed].reverse().map((f: any) => {
          if (f.kind === "system") return <div key={f.id} className="text-center mono text-[10px] text-[#9CA3AF] py-1">— {f.text} —</div>;
          if (f.kind === "call") return (
            <div key={f.id} className="bg-white border border-[var(--line)] rounded-xl p-3">
              <div className="text-sm"><b>{f.name}</b> backed <span className={f.side === 1 ? "text-[var(--green)] font-bold" : "font-bold"}>{f.side === 1 ? "YES" : "NO"}</span> · {f.q}?</div>
              {f.userId !== userId && <button onClick={() => copyCall(f.market, f.side)} className="mt-2 h-8 px-3 rounded-lg bg-[var(--ink)] text-white text-xs font-bold">Copy this call</button>}
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
function buildTimeline(recent: any[], home: string, away: string) {
  const evs: { min: string; icon: string; text: string; big?: boolean }[] = [];
  let pg1 = 0, pg2 = 0, py = 0, pr = 0, pc = 0;
  for (const e of recent) {
    const s = e.Stats || {};
    const g1 = Number(s[1] || 0), g2 = Number(s[2] || 0);
    const yc = Number(s[3] || 0) + Number(s[4] || 0), rc = Number(s[5] || 0) + Number(s[6] || 0), co = Number(s[7] || 0) + Number(s[8] || 0);
    const min = e.Clock?.Seconds != null ? `${Math.floor(Number(e.Clock.Seconds) / 60)}'` : "";
    if (g1 > pg1) evs.push({ min, icon: "⚽", text: `GOAL — ${home}`, big: true });
    if (g2 > pg2) evs.push({ min, icon: "⚽", text: `GOAL — ${away}`, big: true });
    if (rc > pr) evs.push({ min, icon: "🟥", text: "Red card" });
    if (yc > py) evs.push({ min, icon: "🟨", text: "Booking" });
    if (co > pc) evs.push({ min, icon: "🚩", text: "Corner" });
    if (e.Action === "high_danger_possession") evs.push({ min, icon: "🔥", text: "Big chance", big: true });
    else if (e.Data?.Goal) evs.push({ min, icon: "👀", text: "Goal building" });
    pg1 = g1; pg2 = g2; py = yc; pr = rc; pc = co;
  }
  return evs.slice(-14).reverse();
}

function Live({ fixtureId, onFreeze, onBlackout }: { fixtureId: number; onFreeze: () => void; onBlackout: () => void }) {
  const [scores, setScores] = useState<any>(null);
  const [err, setErr] = useState(false);
  const f = FIXTURES[String(fixtureId)] || { home: "Home", away: "Away" };
  useEffect(() => {
    let on = true;
    const tick = () => getScores(fixtureId).then((s) => { if (on) { s?.error ? setErr(true) : (setScores(s), setErr(false)); } }).catch(() => on && setErr(true));
    tick(); const t = setInterval(tick, 8000);
    return () => { on = false; clearInterval(t); };
  }, [fixtureId]);

  const recent: any[] = scores?.recent || [];
  const latest = recent[recent.length - 1];
  const g1 = Number(latest?.Stats?.[1] || 0), g2 = Number(latest?.Stats?.[2] || 0);
  const secs = latest?.Clock?.Seconds != null ? Number(latest.Clock.Seconds) : null;
  const running = latest?.Clock?.Running;
  const state: string = latest?.GameState || "";
  const clock = secs != null ? `${Math.floor(secs / 60)}'` : "";
  const phase = state === "scheduled" ? "Kick-off soon" : running ? `Live ${clock}` : clock ? `${clock}` : "Match Centre";
  const timeline = buildTimeline(recent, f.home, f.away);

  return (
    <div>
      <Section title={`Match Centre · ${f.home} v ${f.away}`} />
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{running ? <><span className="inline-block w-2 h-2 rounded-full bg-[var(--greenb)] gf-pulse mr-1.5 align-middle" />Live</> : "Match Centre"}</span>
          <span className="mono text-[10px] text-[#9CA3AF]">{phase}</span>
        </div>
        {err && !scores ? (
          <div className="text-sm text-[#9CA3AF] mt-4 text-center py-4">Match feed is catching its breath — back in a moment.</div>
        ) : !scores ? (
          <div className="text-sm text-[#9CA3AF] mt-4 text-center py-4">Connecting to the match…</div>
        ) : (
          <div className="flex items-center justify-center gap-5 mt-4">
            <div className="flex-1 text-right"><div className="text-lg font-bold">{f.home}</div></div>
            <div className="text-5xl font-extrabold tabular-nums">{g1}<span className="text-[#6B7280] px-2">–</span>{g2}</div>
            <div className="flex-1 text-left"><div className="text-lg font-bold">{f.away}</div></div>
          </div>
        )}
        <div className="text-[12px] text-[#9CA3AF] mt-4 text-center">Make a call from Today and watch it settle the second it counts.</div>
      </div>

      {/* THE FROZEN WINDOW — the one surface that opens exactly when every sportsbook locks its doors. */}
      <div className="mt-4 rounded-2xl p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#111,#0b2a1e)" }}>
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">The Frozen Window</div>
        <div className="text-[15px] font-bold mt-1.5 leading-snug">The minute every sportsbook locks its doors, our round opens — and winners are paid before the commentator finishes his sentence.</div>
        <div className="flex gap-2 mt-3">
          <button onClick={onFreeze} className="flex-1 h-11 rounded-xl bg-white text-[var(--ink)] font-bold text-sm">⏱️ The Freeze</button>
          <button onClick={onBlackout} className="flex-1 h-11 rounded-xl bg-[#1d1d1f] border border-[#2c2c2e] font-bold text-sm">… Blackout</button>
        </div>
        <div className="mono text-[10px] text-[#6B7280] mt-2">Replays a real VAR / market-silence moment from the match feed.</div>
      </div>

      <Section title="Timeline" />
      {scores && timeline.length === 0 && <div className="text-sm text-[var(--muted)] py-4 text-center">No big moments yet — it&apos;s all to play for.</div>}
      <div className="space-y-1">
        {timeline.map((ev, i) => (
          <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${ev.big ? "bg-[var(--green)]/10" : "bg-white border border-[var(--line)]"}`}>
            <span className="mono text-[11px] font-semibold w-9 text-[var(--muted)]">{ev.min}</span>
            <span className="text-lg">{ev.icon}</span>
            <span className={`text-sm flex-1 ${ev.big ? "font-bold" : ""}`}>{ev.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FrozenWindow({ round, userId, onCall, onDismiss, onPinLore }: any) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  const f = FIXTURES[String(round.fixtureId)] || { home: "Home", away: "Away" };
  const freeze = round.kind === "freeze";
  const myCall: string | undefined = round.calls?.find((c: any) => c.userId === userId)?.side;
  const settled = round.state === "settled";
  const locked = settled || now >= round.locksAt;
  const secsToLock = Math.max(0, Math.ceil((round.locksAt - now) / 1000));
  const total: number = Object.values(round.tally || {}).reduce((a: number, b: any) => a + Number(b), 0);
  const sweat: { t: number; pct: number }[] = round.sweat || [];
  const lastPct = sweat.length ? sweat[sweat.length - 1].pct : null;
  const won = settled && myCall && myCall === round.outcome;

  // option → label (Blackout maps HOME/AWAY to team names)
  const optLabel = (o: string) => (o === "HOME GOAL" ? `${f.home} GOAL` : o === "AWAY GOAL" ? `${f.away} GOAL` : o);
  const optClass = (o: string) => {
    const chosen = myCall === o;
    if (o === "STANDS") return chosen ? "bg-[var(--green)] text-white" : "bg-white/10 text-white border border-white/25";
    if (o === "OVERTURNED") return chosen ? "bg-red-600 text-white" : "bg-white/10 text-white border border-white/25";
    return chosen ? "bg-[var(--greenb)] text-[var(--ink)]" : "bg-white/10 text-white border border-white/25";
  };

  const bg = freeze
    ? "radial-gradient(120% 90% at 50% 25%, #0b3b2a, #05100b)"
    : "radial-gradient(120% 90% at 50% 30%, #14141a, #060608)";

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center text-white px-7 text-center" style={{ background: bg }}>
      {!settled ? (
        <>
          <div className="mono text-[10px] tracking-[0.3em] uppercase text-[var(--greenb)]">{freeze ? "The Freeze" : "Blackout"} · {f.home} v {f.away}</div>
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
            <div className="mt-5 mono text-sm text-white/60">🔒 Locked — sweating it out</div>
          )}

          {/* options */}
          <div className={`mt-4 w-full max-w-xs grid ${round.options.length > 2 ? "grid-cols-1" : "grid-cols-2"} gap-2`}>
            {round.options.map((o: string) => (
              <button key={o} disabled={locked || !!myCall} onClick={() => onCall(round.id, o)} className={`h-14 rounded-2xl font-extrabold disabled:opacity-70 ${optClass(o)}`}>{optLabel(o)}</button>
            ))}
          </div>
          {myCall && <div className="mt-3 mono text-[11px] text-white/60">You called <b className="text-white">{optLabel(myCall)}</b></div>}

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
          <div className="mt-5 mono text-[11px] text-white/40">{total} in{total > 0 ? " — verdict pays the readers" : ""}</div>
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
          <div className="mt-5 flex gap-2">
            {won && <button onClick={() => onPinLore(`${optLabel(round.outcome)} — I called it. ${round.lore}`)} className="flex-1 py-3.5 rounded-2xl bg-white/15 text-white font-bold text-sm">📌 Pin to lore</button>}
            <button onClick={onDismiss} className="flex-1 py-3.5 rounded-2xl bg-white text-[#05100b] font-bold">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Cash({ bal, fund, busy, short, markets, label, claim, setDetail, positions = [] }: any) {
  // Only YOUR claimable pots: a settled-YES pool where you hold an unclaimed YES stake, or a voided
  // pool where you hold any unclaimed stake (refund). No more "Claim" on pools you never entered.
  const hasUnclaimed = (mkt: string, sideNeeded: number | null) =>
    positions.some((p: any) => p.market === mkt && !p.claimed && p.amount > 0 && (sideNeeded === null || p.side === sideNeeded));
  const claimable = markets.filter((m: MarketView) =>
    (m.status === 1 && hasUnclaimed(m.pubkey, 1)) || (m.status === 2 && hasUnclaimed(m.pubkey, null))
  ).slice(0, 8);
  return (
    <div>
      <Section title="Your cash" />
      <div className="bg-[var(--ink)] rounded-3xl p-6 text-white">
        <div className="mono text-[10px] uppercase tracking-widest text-[#9CA3AF]">Balance</div>
        <div className="text-5xl font-extrabold tracking-tight mt-2 tabular-nums">{fmtAmt(bal)}</div>
        <div className="mt-2 text-[12px] text-[var(--greenb)]">✓ Yours instantly. Can&apos;t be clawed back.</div>
        <button disabled={busy === "fund"} onClick={fund} className="mt-5 w-full h-12 rounded-xl bg-white text-[var(--ink)] font-bold disabled:opacity-50">{busy === "fund" ? "Adding…" : "Add funds"}</button>
      </div>
      <Section title="Ready to collect" />
      {claimable.length === 0 && <div className="text-sm text-[var(--muted)] py-4">Nothing to collect yet — your winning calls land here.</div>}
      {claimable.map((m: MarketView) => (
        <Card key={m.pubkey} m={m} label={label} onOpen={() => setDetail?.(m)}><button disabled={!!busy} onClick={() => claim(m)} className="mt-3 w-full h-11 rounded-xl bg-[var(--green)] text-white font-bold disabled:opacity-50">{m.status === 2 ? "Get your money back →" : "Collect →"}</button></Card>
      ))}
    </div>
  );
}

function You({ short, streak, bal, points, nation, userName, userId, flash }: any) {
  const [grid, setGrid] = useState<{ cells: ("hit" | "freeze" | "miss")[]; streak: number; alivePct: number | null } | null>(null);
  useEffect(() => { if (userId) streakGridApi(userId).then(setGrid); }, [userId]);
  const name = userName && userName !== "You" ? userName : "You";
  const cell = (c: string) => (c === "hit" ? "✅" : c === "freeze" ? "🧊" : "⬜");
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
        <div className="w-16 h-16 rounded-full bg-[var(--ink)] text-white flex items-center justify-center text-xl font-bold">{(name[0] || "Y").toUpperCase()}</div>
        <div><div className="text-2xl font-bold">{name}</div><div className="mono text-[10px] text-[var(--muted)]">{nation} · {short}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-5">
        {[[streak, "DAY STREAK"], [points, "POINTS"], [fmtAmt(bal), "BALANCE"]].map(([v, k]: any, i: number) => (<div key={i} className="bg-white border border-[var(--line)] rounded-2xl p-4"><div className="text-3xl font-extrabold tabular-nums">{v}</div><div className="mono text-[9px] tracking-wide text-[#9CA3AF] mt-1">{k}</div></div>))}
      </div>
      {grid && grid.cells.length > 0 && (
        <div className="mt-4 bg-white border border-[var(--line)] rounded-2xl p-4">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">Your run</div>
          <div className="text-2xl mt-2 tracking-tight leading-none break-all">{grid.cells.map(cell).join("")}</div>
          <div className="text-sm font-semibold mt-2">{grid.streak > 0 ? `Still alive — ${grid.streak}-day streak.` : "Run's over. New one starts today."}{grid.alivePct != null && grid.streak > 0 ? ` ${grid.alivePct}% of the world isn't.` : ""}</div>
          <button onClick={shareGrid} className="mt-3 h-9 px-4 rounded-lg bg-[var(--ink)] text-white text-sm font-bold">Share your grid</button>
        </div>
      )}
      <div className="mt-6 bg-[var(--ink)] rounded-2xl p-5 text-white"><div className="mono text-[10px] uppercase tracking-widest text-[var(--greenb)]">Why GAFFER</div><div className="text-lg font-bold mt-2">Win all you want. Paid the instant it happens. And we can prove it — every time.</div></div>
    </div>
  );
}

function Logo() {
  return (<svg viewBox="0 0 64 64" width="24" height="24" fill="none"><circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="6.5" /><line x1="32" y1="6" x2="32" y2="58" stroke="currentColor" strokeWidth="6.5" /><circle cx="32" cy="32" r="6" fill="currentColor" /></svg>);
}
