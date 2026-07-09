"use client";
import { useEffect } from "react";

/** Tell the Farcaster client we've painted, so it drops its splash screen.
 *
 * Imported lazily: outside a Farcaster client `ready()` simply has nobody to talk to, and a shell must
 * never break the page it is shelling. Any failure here is silent by design — the web app carries on. */
export default function FarcasterReady() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sdk } = await import("@farcaster/miniapp-sdk");
        if (cancelled) return;
        await sdk.actions.ready();
      } catch { /* not inside a Farcaster client — nothing to tell */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
}
