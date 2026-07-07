"use client";
import { team } from "@/lib/teams";

/** Crisp SVG flag (flag-icons) for a team name, at any size. Falls back to a neutral roundel disc
 * for a nation outside the map so a surface never shows a broken image. `size` is the width in px
 * (flag-icons renders 4:3; we use the squared variant for roundels). */
export function Flag({ name, size = 18, round = false, className = "" }: { name: string; size?: number; round?: boolean; className?: string }) {
  const t = team(name);
  if (!t.iso) return <span className={`inline-flex items-center justify-center rounded-full bg-[var(--line)] mono font-bold ${className}`} style={{ width: size, height: size, fontSize: size * 0.34 }}>{t.code || "?"}</span>;
  if (round) {
    // fis = squared 1:1 → crop to a circle for the roundel look.
    return <span className={`fi fi-${t.iso} fis ${className}`} style={{ width: size, height: size, borderRadius: "50%", display: "inline-block", backgroundSize: "cover", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.08)" }} aria-label={name} />;
  }
  return <span className={`fi fi-${t.iso} ${className}`} style={{ width: size, height: size * 0.75, display: "inline-block", borderRadius: 2, backgroundSize: "cover", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.08)" }} aria-label={name} />;
}

/** The designed stand-in for a federation crest (which we can't legally use): circular flag + code. */
export function Roundel({ name, size = 34 }: { name: string; size?: number }) {
  const t = team(name);
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <Flag name={name} size={size} round />
      <span className="mono text-[9px] font-bold tracking-widest text-[var(--muted)]">{t.code}</span>
    </span>
  );
}

/** "🇺🇸 v 🇧🇦" as real flags — the match identity used on cards and rails. */
export function FlagPair({ home, away, size = 14 }: { home: string; away: string; size?: number }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <Flag name={home} size={size} round />
      <span className="mono text-[9px] text-[var(--muted)]">v</span>
      <Flag name={away} size={size} round />
    </span>
  );
}
