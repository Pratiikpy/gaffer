"use client";
import { useCallback, useEffect, useState } from "react";

/** Q7 — THE ROUND TABLE.
 *
 * Draft night, in the squad. Everyone watches the same countdown; the person on the clock picks a
 * surviving nation, and when the clock runs out the pick is made for them so the room never stalls.
 * The order puts the wooden spoon first and snakes back, which is the only ordering worth turning up to.
 */

type Draft = {
  id: string; round: number; state: "live" | "done";
  order: { pickNo: number; userId: string; name: string }[];
  picks: { nation: string; userId: string; name: string; pickNo: number; auto: boolean }[];
  available: string[];
  onTheClock: { userId: string; name: string; pickNo: number } | null;
  deadline: number; pickSecs: number; msLeft: number; totalPicks: number;
};

export default function RoundTable({ code, userId, token, isOwner, flash }: {
  code: string; userId: string; token: string; isOwner: boolean; flash?: (m: string, k?: "ok" | "err") => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch(`/api/draft?code=${code}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r?.draft) { setDraft(r.draft); setLeft(Math.ceil(r.draft.msLeft / 1000)); }
    else setDraft(null);
  }, [code]);

  // Poll the draft (the read also advances an expired clock server-side) and tick the countdown locally.
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(t); }, []);

  const start = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", code, userId, token }) }).then((x) => x.json());
      if (r?.draft) { setDraft(r.draft); flash?.("Draft night. Wooden spoon picks first."); }
      else flash?.(r?.error || "Couldn't start the draft.", "err");
    } finally { setBusy(false); }
  };

  const pick = async (nation: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pick", code, userId, token, nation }) }).then((x) => x.json());
      if (r?.draft) { setDraft(r.draft); setLeft(Math.ceil(r.draft.msLeft / 1000)); flash?.(`${nation} is yours.`); }
      else flash?.(r?.error || "Couldn't make that pick.", "err");
    } finally { setBusy(false); }
  };

  if (!draft) {
    if (!isOwner) return null;
    return (
      <div className="mt-4 rounded-2xl p-4 border-2 border-dashed border-[var(--line)] bg-white">
        <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)]">The Round Table</div>
        <div className="text-sm font-bold mt-0.5">Draft the surviving nations.</div>
        <p className="text-[12px] text-[var(--muted)] mt-0.5">Everyone on one clock. Last place picks first. Their results score for you all round.</p>
        <button onClick={start} disabled={busy} className="mt-3 w-full py-2.5 rounded-xl bg-[var(--ink)] text-white font-bold text-sm disabled:opacity-40">Call the draft</button>
      </div>
    );
  }

  const mine = draft.picks.filter((p) => p.userId === userId);
  const yours = draft.onTheClock?.userId === userId;
  const done = draft.state === "done";

  return (
    <div className="mt-4 rounded-2xl p-4 bg-[var(--dark)] text-white">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">The Round Table · round {draft.round}</span>
        <span className="mono text-[10px] text-white/50">{draft.picks.length}/{draft.totalPicks}</span>
      </div>

      {done ? (
        <div className="mt-2 text-sm font-bold">Draft complete. Their results are yours all round.</div>
      ) : (
        <>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-lg font-black">{yours ? "You're on the clock." : `${draft.onTheClock?.name} is picking.`}</span>
            <span className={`mono text-lg font-black tabular-nums ${left <= 10 ? "text-[#D8A32B]" : "text-white/70"}`}>{left}s</span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-[var(--greenb)] transition-all duration-1000 ease-linear" style={{ width: `${Math.min(100, (left / draft.pickSecs) * 100)}%` }} />
          </div>

          {yours && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {draft.available.map((n) => (
                <button key={n} onClick={() => pick(n)} disabled={busy}
                  className="px-2.5 py-1.5 rounded-lg bg-white/10 text-white text-[12px] font-bold active:scale-95 transition-transform disabled:opacity-40">{n}</button>
              ))}
            </div>
          )}
          {!yours && <p className="mt-2 text-[12px] text-white/50">If the clock beats them, we&apos;ll pick for them.</p>}
        </>
      )}

      {draft.picks.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/10">
          <div className="mono text-[10px] tracking-widest uppercase text-white/40 mb-1.5">Taken</div>
          <div className="flex flex-wrap gap-1.5">
            {draft.picks.map((p) => (
              <span key={p.nation} className={`px-2 py-1 rounded-lg text-[11px] font-bold ${p.userId === userId ? "bg-[var(--greenb)] text-[var(--ink)]" : "bg-white/10 text-white/70"}`}>
                {p.nation}<span className="opacity-50 font-normal"> · {p.name}{p.auto ? " (auto)" : ""}</span>
              </span>
            ))}
          </div>
          {mine.length > 0 && <div className="mt-2 text-[12px] text-[var(--greenb)] font-bold">You hold {mine.map((p) => p.nation).join(", ")}.</div>}
        </div>
      )}
    </div>
  );
}
