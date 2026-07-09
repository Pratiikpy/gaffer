"use client";
import { useEffect, useRef, useState } from "react";

/** Q8 — MYSTERY MATCH.
 *
 * A finished game, replayed anonymously from its real tick stream as a three-minute drama run. You never
 * learn who's playing until the end, so you're reading the game rather than remembering the result. The
 * beats are real events at their real minutes; the questions land exactly where the market's did.
 *
 * The answers live on the server. This component knows where to stop and what to ask — never what's true.
 */

type Beat = { minute: number; text: string; big: boolean };
type Break = { atBeat: number; minute: number; question: string };
type Run = { fixtureId: number; beats: Beat[]; breaks: Break[]; totalGoals: number };
type Result = { right: number; total: number; points: number; answers: { atBeat: number; answer: "yes" | "no" }[]; finalHome: number; finalAway: number; home: string | null; away: string | null };

const BEAT_MS = 4200; // 40 beats ≈ 3 minutes, with pauses for the calls

export default function MysteryMatch({ fixtureId, userId, token, onClose, onPoints }: {
  fixtureId: number; userId: string; token: string; onClose: () => void; onPoints?: (p: number) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);                       // current beat
  const [asking, setAsking] = useState<Break | null>(null);
  const [calls, setCalls] = useState<{ atBeat: number; side: "yes" | "no" }[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/mystery?fixture=${fixtureId}`)
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setRun(j)))
      .catch(() => setErr("The vault is catching its breath."));
  }, [fixtureId]);

  // The run plays itself, stopping whenever a beat carries a question.
  useEffect(() => {
    if (!run || asking || result) return;
    if (i >= run.beats.length) { void grade(); return; }
    const q = run.breaks.find((b) => b.atBeat === i);
    if (q && !calls.some((c) => c.atBeat === i)) { setAsking(q); return; }
    timer.current = setTimeout(() => setI((n) => n + 1), run.beats[i].big ? BEAT_MS * 1.6 : BEAT_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [run, i, asking, result, calls]);

  const answer = (side: "yes" | "no") => {
    if (!asking) return;
    setCalls((c) => [...c, { atBeat: asking.atBeat, side }]);
    setAsking(null);
    setI((n) => n + 1);
  };

  const grade = async () => {
    if (!run || busy || result) return;
    setBusy(true);
    try {
      const r = await fetch("/api/mystery", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, token, fixtureId, calls }),
      }).then((x) => x.json());
      if (r?.error) setErr(r.error);
      else { setResult(r); if (r.points) onPoints?.(r.points); }
    } finally { setBusy(false); }
  };

  if (err) return (
    <Shell onClose={onClose}>
      <div className="text-center py-10">
        <div className="text-sm text-white/70">{err}</div>
        <button onClick={onClose} className="mt-5 px-5 py-2.5 rounded-xl bg-white text-[var(--ink)] font-bold text-sm">Back</button>
      </div>
    </Shell>
  );

  if (!run) return <Shell onClose={onClose}><div className="text-center py-16 text-white/60 text-sm">Opening the vault…</div></Shell>;

  if (result) {
    const pct = result.total ? Math.round((result.right / result.total) * 100) : 0;
    return (
      <Shell onClose={onClose}>
        <div className="text-center py-6">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">The reveal</div>
          <div className="text-5xl font-black mt-2 tabular-nums">{result.right}<span className="text-white/40 text-3xl">/{result.total}</span></div>
          <div className="text-white/70 text-sm mt-1">You read {pct}% of it right.</div>
          <div className="mt-5 rounded-2xl bg-white/10 p-4">
            <div className="mono text-[10px] tracking-widest uppercase text-white/50">It was</div>
            {result.home && result.away ? (
              <div className="text-lg font-bold mt-1 leading-tight">{result.home} <span className="text-white/40">v</span> {result.away}</div>
            ) : null}
            <div className="text-3xl font-extrabold tabular-nums mt-1">{result.finalHome} – {result.finalAway}</div>
          </div>
          {result.points > 0 && <div className="mt-3 text-[var(--greenb)] font-bold text-sm">+{result.points} points banked.</div>}
          <button onClick={onClose} className="mt-6 w-full py-3.5 rounded-2xl bg-white text-[var(--ink)] font-bold">Done</button>
        </div>
      </Shell>
    );
  }

  const beat = run.beats[Math.min(i, run.beats.length - 1)];
  const progress = Math.round((i / run.beats.length) * 100);

  return (
    <Shell onClose={onClose}>
      <div className="mono text-[10px] tracking-widest uppercase text-white/40 flex items-center justify-between">
        <span>Mystery match</span><span>{calls.length}/{run.breaks.length} called</span>
      </div>
      <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-[var(--greenb)] transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>

      <div className="min-h-[220px] flex flex-col items-center justify-center text-center">
        <div className="mono text-[11px] text-white/40">{beat.minute}&apos;</div>
        <div className={`mt-1 ${beat.big ? "text-4xl font-black text-[var(--greenb)]" : "text-xl font-semibold text-white/90"}`}>
          {beat.text}
        </div>
        {beat.big && <div className="mt-1 text-white/50 text-sm">Someone has scored.</div>}
      </div>

      {asking && (
        <div className="rounded-2xl bg-white/10 p-4">
          <div className="mono text-[10px] tracking-widest uppercase text-[var(--greenb)]">{asking.minute}&apos; · your call</div>
          <div className="text-lg font-bold mt-1">{asking.question}</div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => answer("yes")} className="flex-1 py-3 rounded-xl bg-[var(--greenb)] text-[var(--ink)] font-bold">Yes</button>
            <button onClick={() => answer("no")} className="flex-1 py-3 rounded-xl bg-white/15 text-white font-bold">No</button>
          </div>
        </div>
      )}
      {!asking && <div className="text-center text-white/30 mono text-[10px] uppercase tracking-widest py-2">{busy ? "Reading the tape…" : "Watching…"}</div>}
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] text-white px-6 py-8 flex flex-col justify-between" style={{ background: "radial-gradient(120% 90% at 50% 20%, #101a16, #0b0b0c)" }}>
      <button onClick={onClose} aria-label="Close" className="self-end w-9 h-9 rounded-full bg-white/10 text-white/70 text-lg leading-none">×</button>
      <div className="flex-1 flex flex-col justify-center gap-5 max-w-sm w-full mx-auto">{children}</div>
    </div>
  );
}
