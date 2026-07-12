import type { Metadata } from "next";

/** The shareable "I called it" landing. Its whole job is the link unfurl: whatever win params a share
 * carries (amount, question, called-at %, multiple) become the OG image — the visual "+X paid" card that
 * travels in a group chat. A viewer who taps through lands here on the card with a Play-free CTA, which is
 * the top of the funnel. Nothing here is fabricated — the numbers are the sharer's own settled win. */

export const dynamic = "force-dynamic";

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function ogUrl(sp: SP): string {
  const q = new URLSearchParams();
  for (const k of ["amount", "q", "called", "mult", "lang"]) { const v = one(sp[k]); if (v) q.set(k, v); }
  return `/api/og?${q.toString()}`;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  const sp = await searchParams;
  const amount = one(sp.amount);
  const es = (one(sp.lang) || "").toLowerCase().startsWith("es");
  const title = amount ? `+${amount} — ${es ? "lo dije, y me pagó" : "I called it, and it paid"}` : "GAFFER";
  const desc = es ? "El juego del Mundial que ya juegas en el grupo — ahora de verdad, y se liquida solo." : "The World Cup game you already play in the group chat — now real, and it settles itself.";
  const img = ogUrl(sp);
  return {
    title, description: desc,
    openGraph: { title, description: desc, images: [{ url: img, width: 1200, height: 630 }], type: "website" },
    twitter: { card: "summary_large_image", title, description: desc, images: [img] },
  };
}

export default async function WinPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const amount = one(sp.amount) || "";
  const q = one(sp.q) || "";
  const called = one(sp.called);
  const mult = one(sp.mult);
  const es = (one(sp.lang) || "").toLowerCase().startsWith("es");
  return (
    <main style={{ minHeight: "100dvh", background: "radial-gradient(120% 90% at 50% 25%, #047857, #052e22 70%)", color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", fontFamily: "ui-sans-serif, system-ui, sans-serif", textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <div style={{ width: 22, height: 22, borderRadius: "50%", border: "3px solid #fff" }} />
        <span style={{ fontWeight: 800, letterSpacing: "-0.5px", fontSize: 22 }}>gaffer.</span>
      </div>
      {amount ? <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: "-3px", color: "#6ee7b7", lineHeight: 1 }}>{`+${amount}`}</div> : null}
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-1px", marginTop: 10 }}>{es ? "Lo dije, y me pagó." : "I called it, and it paid."}</div>
      {q ? <div style={{ fontSize: 17, color: "rgba(255,255,255,.82)", marginTop: 16, maxWidth: 460 }}>{`“${q}”`}</div> : null}
      {called ? <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: "rgba(255,255,255,.6)", marginTop: 14 }}>{es ? `Fijado en ${called}%` : `Called at ${called}%`}{mult ? ` · ${mult}×` : ""}</div> : null}
      <a href="/" style={{ marginTop: 34, background: "#fff", color: "#052e22", fontWeight: 800, fontSize: 17, padding: "15px 30px", borderRadius: 16, textDecoration: "none" }}>{es ? "Juega gratis →" : "Play free →"}</a>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "rgba(255,255,255,.45)", marginTop: 22, letterSpacing: ".08em" }}>{es ? "sin casa · el resultado libera el dinero" : "no house · the result releases the money"}</div>
    </main>
  );
}
