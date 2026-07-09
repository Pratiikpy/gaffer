"use client";
/** C5 — the money sound + haptic map.
 *
 * One ownable two-note rising chime (G4 → D5) synthesised in WebAudio: no asset to download, no
 * licence, identical on every device. It plays ONLY when money lands — never on a stake (the Robinhood
 * rule: celebrate the outcome, never the wager). Default OFF; the fan opts in with "Stadium sound",
 * because an app that makes noise unasked is an app people mute forever.
 *
 * iOS gives PWAs no vibration API, so the haptic layer degrades silently and the motion carries it.
 */

const KEY = "gaffer_sound";
export const soundOn = (): boolean => typeof window !== "undefined" && localStorage.getItem(KEY) === "1";
export const setSoundOn = (on: boolean) => { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ } };

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  // Browsers suspend the context until a gesture; a claim IS a gesture, so this resolves in practice.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** One note: a soft triangle with a fast attack and a long, gentle tail — a chime, not a beep. */
function note(ac: AudioContext, freq: number, startAt: number, dur: number, peak: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);      // fast attack
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);      // long decay
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

/** The payout chime: G4 → D5, a rising fifth. Plays only if the fan turned Stadium sound on. */
export function playPaid() {
  if (!soundOn()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  note(ac, 392.0, t, 0.42, 0.16);          // G4
  note(ac, 587.33, t + 0.11, 0.62, 0.13);  // D5
}

/** The haptic that lands with the money. Silent no-op where unsupported (iOS). */
export function hapticPaid() {
  try { (navigator as any).vibrate?.([0, 45, 35, 70]); } catch { /* unsupported */ }
}
