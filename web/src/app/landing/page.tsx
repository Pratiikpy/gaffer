"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { GAMES } from "@/lib/features";

/** The living marketing home (§12.4) — renders the wedge, the un-voidable promise, the live game
 * registry (features.ts), and a real pot number pulled from the same /api the app runs on, so it is
 * never a stale brochure. A separate route (`/landing`) so the app root stays the game itself. */
export default function Landing() {
  const [pot, setPot] = useState<number | null>(null);
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/markets").then((r) => r.json()).then((d) => {
      const ms = d.markets || [];
      setPot(ms.reduce((s: number, m: any) => s + (m.potSol || 0), 0));
      setLive(ms.filter((m: any) => m.statusLabel === "live").length);
    }).catch(() => {});
  }, []);
  const games = GAMES.filter((g) => g.status === "live");

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <div className="max-w-[440px] mx-auto px-6 py-10">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-extrabold tracking-tight">gaffer.</span>
          <span className="mono text-[9px] tracking-widest uppercase text-[var(--muted)]">The Tournament</span>
        </div>

        {/* Hero */}
        <h1 className="text-[40px] leading-[1.05] font-extrabold tracking-tight mt-10">Call it. Get paid the second it happens.</h1>
        <p className="text-[17px] text-[var(--muted)] mt-4 leading-relaxed">The World Cup game you already play in the group chat — now real, and it settles itself. No bookie. No house. No one who can void your win.</p>

        {/* Live proof strip — real numbers from the same feed the app runs on */}
        <div className="mt-6 rounded-2xl bg-[var(--ink)] text-white p-5">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">Live right now</div>
          <div className="flex items-end gap-6 mt-2">
            <div><div className="text-3xl font-extrabold tabular-nums">{pot != null ? pot.toFixed(2) : "—"}</div><div className="mono text-[9px] uppercase tracking-widest text-[#9CA3AF] mt-1">in open pots</div></div>
            <div><div className="text-3xl font-extrabold tabular-nums">{live != null ? live : "—"}</div><div className="mono text-[9px] uppercase tracking-widest text-[#9CA3AF] mt-1">live pools</div></div>
          </div>
        </div>

        {/* The promise */}
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-5">
          <div className="text-[15px] font-bold">When you win, the pool pays you automatically.</div>
          <div className="text-[14px] text-[var(--muted)] mt-1 leading-relaxed">No one can void it, limit you, or hold your payout — and every win comes with a receipt you can check.</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["No ads. Ever.", "Win too much? We can't ban you.", "Runs on real World Cup data"].map((t) => (
              <span key={t} className="mono text-[10px] font-semibold text-[var(--muted)] bg-[#FAFAF7] border border-[var(--line)] rounded-full px-2.5 py-1">{t}</span>
            ))}
          </div>
        </div>

        {/* What's inside — rendered from the single feature registry */}
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)] mt-8 mb-2">What&apos;s inside</div>
        <div className="grid grid-cols-2 gap-2">
          {games.map((g) => (
            <div key={g.id} className="rounded-2xl bg-white border border-[var(--line)] p-3.5">
              <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[var(--green)]" /><span className="text-sm font-bold">{g.name}</span></div>
              <div className="text-[11px] text-[var(--muted)] mt-1 leading-snug">{g.blurb}</div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <Link href="/" className="mt-8 block w-full h-14 rounded-2xl bg-[var(--ink)] text-white text-lg font-bold flex items-center justify-center">Play free →</Link>
        <p className="text-center mono text-[10px] text-[var(--muted)] mt-3">18+. Free to play. No purchases.</p>
      </div>
    </div>
  );
}
