"use client";
import { useEffect, useState } from "react";
import GafferApp from "@/components/GafferApp";

/** The Telegram mini-app shell.
 *
 * Three shells, one product: this renders the SAME app, against the same `/api` and the same kernel, so
 * nothing here is a fork. What the shell adds is Telegram itself — the viewport, the theme, the back
 * button, and a verified identity.
 *
 * The identity is checked on the SERVER (`/api/telegram` verifies the bot-token signature). A mini-app
 * that trusted `initData` client-side would let anyone be anyone by editing a string, so we never read
 * the user out of it here. Money identity stays the wallet, exactly as on the web: Telegram tells us who
 * you are socially, never what you own.
 */

type TG = {
  ready: () => void; expand: () => void;
  initData: string;
  colorScheme?: string;
  themeParams?: Record<string, string>;
  setHeaderColor?: (c: string) => void;
  setBackgroundColor?: (c: string) => void;
};

declare global { interface Window { Telegram?: { WebApp?: TG } } }

export default function TelegramShell() {
  const [state, setState] = useState<"loading" | "ready" | "outside" | "error">("loading");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const tg = window.Telegram?.WebApp;
      if (!tg || !tg.initData) { if (!cancelled) setState("outside"); return; }

      tg.ready();
      tg.expand();
      try { tg.setHeaderColor?.("#0e0e0f"); tg.setBackgroundColor?.("#FAFAF7"); } catch { /* older clients */ }

      const r = await fetch("/api/telegram", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: tg.initData }),
      }).then((x) => x.json()).catch(() => null);

      if (cancelled) return;
      if (!r || r.error) { setState("error"); setMsg(r?.error === "unauthorized" ? "Telegram couldn't confirm it's you." : r?.error || "Something went wrong."); return; }

      // The verified name is the only thing the shell hands the app; the points token lets the app
      // record activity against the same server-authoritative ledger as every other shell.
      try {
        localStorage.setItem("gaffer_name", r.name);
        localStorage.setItem("gaffer_ptoken", r.token);
        localStorage.setItem("gaffer_tg_user", r.userId);
      } catch { /* private mode */ }
      setState("ready");
    };

    // The SDK script may still be loading when we mount.
    if (window.Telegram?.WebApp) void boot();
    else {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js";
      s.async = true;
      s.onload = () => void boot();
      s.onerror = () => !cancelled && setState("outside");
      document.head.appendChild(s);
    }
    return () => { cancelled = true; };
  }, []);

  if (state === "loading") return <Splash line="Opening GAFFER…" />;
  if (state === "outside") return (
    <Splash line="Open this inside Telegram.">
      <a href="/" className="mt-4 inline-block px-5 py-2.5 rounded-xl bg-[var(--ink)] text-white font-bold text-sm">Play on the web instead</a>
    </Splash>
  );
  if (state === "error") return <Splash line={msg}><a href="/" className="mt-4 inline-block px-5 py-2.5 rounded-xl bg-[var(--ink)] text-white font-bold text-sm">Play on the web</a></Splash>;

  return <GafferApp />;
}

function Splash({ line, children }: { line: string; children?: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <div className="text-2xl font-black tracking-tight">gaffer.</div>
      <div className="mono text-[10px] tracking-widest uppercase text-[var(--muted)] mt-1">World Cup</div>
      <p className="mt-5 text-sm text-[var(--muted)]">{line}</p>
      {children}
    </div>
  );
}
