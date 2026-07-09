"use client";
/** K6 — Add-to-Home-Screen and the Badging API.
 *
 * A PWA that is never installed never gets a push, so the install prompt is part of the notification
 * story rather than a nicety. Chrome hands us `beforeinstallprompt` exactly once and only when the app is
 * actually installable; we hold it and let the fan choose the moment. iOS gives no such event at all, so
 * there we say plainly how to do it rather than showing a button that cannot work.
 *
 * The badge is the quietest notification there is: a number on the icon, no sound, no interruption.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPrompt | null = null;
const listeners = new Set<(can: boolean) => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                 // keep Chrome's own bar away; we choose the moment
    deferred = e as InstallPrompt;
    listeners.forEach((l) => l(true));
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l(false));
  });
}

export const isStandalone = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || (window.navigator as any).standalone === true);

export const isIOS = (): boolean =>
  typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;

/** Can we show a real install button right now? (iOS never can — it has no prompt event.) */
export const canInstall = (): boolean => !!deferred && !isStandalone();

export function onInstallable(cb: (can: boolean) => void): () => void {
  listeners.add(cb);
  cb(canInstall());
  return () => { listeners.delete(cb); };
}

/** Show the browser's install prompt. Returns true only if the fan actually accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const p = deferred;
  deferred = null;
  listeners.forEach((l) => l(false));
  try {
    await p.prompt();
    const { outcome } = await p.userChoice;
    return outcome === "accepted";
  } catch { return false; }
}

/** The quiet notification: a count on the app icon. Silently absent where unsupported. */
export function setBadge(count: number): void {
  try {
    const nav = navigator as any;
    if (count > 0) nav.setAppBadge?.(count);
    else nav.clearAppBadge?.();
  } catch { /* unsupported — the badge is a bonus, never a dependency */ }
}
