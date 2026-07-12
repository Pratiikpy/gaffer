/** N3 — bilingual share artifacts (EN/ES).
 *
 * Mexico is half this market: Telemundo's records are all Mexico fixtures, and the Mexico–England
 * announcement alone did 5.55M views. A share card that only speaks English is a card half the audience
 * won't paste. Only the SHARE surfaces are translated — the app's own voice stays in one language rather
 * than becoming a half-finished translation everywhere.
 */

export type Lang = "en" | "es";

/** Pick a language from the browser, defaulting to English. Spanish for any es-* locale. */
export function detectLang(nav?: { language?: string; languages?: readonly string[] }): Lang {
  const src = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const tags = [src?.language, ...(src?.languages ?? [])].filter(Boolean) as string[];
  return tags.some((t) => t.toLowerCase().startsWith("es")) ? "es" : "en";
}

export const STRINGS = {
  en: {
    calledIt: "I called it on GAFFER",
    paidInstant: "Paid the second it happened.",
    calledAt: (pct: number) => `Called it at ${pct}%`,
    paidMultiple: (m: string) => `paid ${m}×`,
    settledAfter: (s: string) => `Settled ${s} after full-time.`,
    record: (w: number, l: number) => `${w}–${l} this Cup.`,
    stillAlive: (d: number) => `Still alive — ${d}-day streak.`,
    runOver: "Run's over. New one starts today.",
    worldNot: (pct: number) => `${pct}% of the world isn't.`,
    ogTitle: "Call it. Get paid the second it happens.",
    ogSub: "No bookie. No house. No one who can void your win.",
  },
  es: {
    calledIt: "Lo canté en GAFFER",
    paidInstant: "Pagado en el segundo en que pasó.",
    calledAt: (pct: number) => `Lo canté al ${pct}%`,
    paidMultiple: (m: string) => `pagó ${m}×`,
    settledAfter: (s: string) => `Liquidado ${s} después del final.`,
    record: (w: number, l: number) => `${w}–${l} en esta Copa.`,
    stillAlive: (d: number) => `Sigue viva — racha de ${d} días.`,
    runOver: "Se acabó la racha. Hoy empieza otra.",
    worldNot: (pct: number) => `El ${pct}% del mundo ya la perdió.`,
    ogTitle: "Cántalo. Cobra en el segundo en que pasa.",
    ogSub: "Sin casa de apuestas. Nadie puede anular tu premio.",
  },
} as const;

export const t = (lang: Lang) => STRINGS[lang] ?? STRINGS.en;

/** The payout share line, in either language. Kept in one place so the two never drift apart. */
export function shareWin(lang: Lang, opts: { stake?: number; payout: number; question: string; calledAt?: number | null; mult?: number | null; settled?: string | null; record?: { w: number; l: number } | null; url: string }): string {
  const s = t(lang);
  const pair = opts.stake && opts.stake > 0 ? `${opts.stake} → ${opts.payout}. ` : `+${opts.payout}. `;
  const stamp = opts.calledAt != null ? `${s.calledAt(opts.calledAt)}${opts.mult ? ` — ${s.paidMultiple(opts.mult.toFixed(2))}` : ""}. ` : "";
  const fast = opts.settled ? `${s.settledAfter(opts.settled)} ` : "";
  const rec = opts.record ? `${s.record(opts.record.w, opts.record.l)} ` : "";
  return `${s.calledIt} — ${pair}“${opts.question}”. ${stamp}${fast}${rec}${s.paidInstant} 🟢 ${opts.url}`;
}

/** The path to a shareable "I called it" card for one win. Pasted into a chat it unfurls the visual
 * "+X paid" card (via /win's OG image) — the format that actually travels ("$X → pays $Y"). A click lands
 * the viewer on the card with a Play-free CTA: the Sleeper/SportyBet invite loop, on a real payout. */
export function winCardPath(opts: { amount: number | string; question: string; calledAt?: number | null; mult?: number | null; stake?: number | null; lang?: Lang }): string {
  const q = new URLSearchParams();
  q.set("amount", String(opts.amount));
  if (opts.question) q.set("q", opts.question.slice(0, 80));
  if (opts.calledAt != null) q.set("called", String(opts.calledAt));
  if (opts.mult != null) q.set("mult", opts.mult.toFixed(2));
  if (opts.stake != null && opts.stake > 0) q.set("stake", String(opts.stake));
  if (opts.lang === "es") q.set("lang", "es");
  return `/win?${q.toString()}`;
}

/** The streak grid caption, in either language. The grid itself is language-free by design. */
export function shareStreak(lang: Lang, streak: number, alivePct: number | null): string {
  const s = t(lang);
  return streak > 0
    ? `${s.stillAlive(streak)}${alivePct != null ? ` ${s.worldNot(alivePct)}` : ""}`
    : s.runOver;
}
