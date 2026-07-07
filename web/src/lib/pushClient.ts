"use client";
import { pushKey, pushSubscribe } from "./api";

/** base64url VAPID key → the Uint8Array the Push API wants. */
function urlB64ToBytes(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
export function pushPermission(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

/** Full opt-in: register the SW, ask permission, subscribe, and persist the subscription server-side.
 * Returns true only when a live subscription is stored. Any step the user/browser refuses → false. */
export async function enablePush(userId: string, token: string, squadCode: string | null): Promise<boolean> {
  if (!pushSupported() || !userId || !token) return false;
  const key = await pushKey();
  if (!key) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) as BufferSource }));
  return pushSubscribe({ userId, token, subscription: sub.toJSON(), squadCode });
}
