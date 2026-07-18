"use client";
import { useEffect, useState } from "react";

/** Judge surface (not the fan app — jargon is the point here). Proves, live and on-chain, that a forged
 * settlement is rejected: same real proof, one byte flipped, watch the oracle refuse it. */

const INK = "#0A0A0A", BG = "#FAFAF7", GREEN = "#0E9F5B", RED = "#DC2626", MUT = "#6B7280", LINE = "rgba(10,10,10,.10)";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const EX = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

type Demo = { fixtureId: number; seq: number; statKey: number; statValue: number; oracle: string; dsr: string; real: any; forged: any; proven: boolean; error?: string };

function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden>
      <circle cx="32" cy="32" r="22" stroke={INK} strokeWidth="6.5" />
      <line x1="32" y1="6" x2="32" y2="58" stroke={INK} strokeWidth="6.5" />
      <circle cx="32" cy="32" r="6" fill={INK} />
    </svg>
  );
}

export default function FraudPage() {
  const [d, setD] = useState<Demo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    fetch("/api/fraud-demo").then((r) => r.json()).then((j) => { if (!on) return; if (j?.real) setD(j); else setErr(j?.error || "could not run the check"); }).catch((e) => on && setErr(String(e)));
    return () => { on = false; };
  }, []);

  const wrap: React.CSSProperties = { minHeight: "100dvh", background: BG, color: INK, fontFamily: "'Outfit', system-ui, sans-serif", padding: "48px 22px 90px" };
  const page: React.CSSProperties = { maxWidth: 860, margin: "0 auto" };
  const eyebrow: React.CSSProperties = { font: `600 12px/1.5 ${MONO}`, letterSpacing: ".16em", textTransform: "uppercase", color: GREEN };
  const card = (color: string): React.CSSProperties => ({ flex: 1, minWidth: 280, border: `1px solid ${color}`, borderRadius: 16, padding: "22px 22px", background: "#fff" });

  return (
    <div style={wrap}>
      <div style={page}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Mark /><div style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-.02em" }}>gaffer<span style={{ color: GREEN }}>.</span></div></div>
        <div style={{ ...eyebrow, marginTop: 26 }}>The settler cannot lie — proven live on-chain</div>
        <h1 style={{ fontSize: "clamp(30px,5vw,46px)", fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.03, margin: "12px 0 14px", maxWidth: "18ch" }}>Can the settler fake a result?</h1>
        <p style={{ fontSize: 18, lineHeight: 1.5, color: MUT, maxWidth: "62ch", margin: 0 }}>
          GAFFER pays out when the <b style={{ color: INK }}>match result</b> releases the money, not when an operator says so. Below, the same real TxLINE proof is checked by the on-chain oracle two ways — untouched, then with a single byte flipped. It runs live against Solana devnet every time you load this page.
        </p>

        {err && (
          <div style={{ marginTop: 30, border: `1px solid ${LINE}`, borderRadius: 14, padding: "22px", color: MUT }}>
            Couldn&apos;t run the check right now — {err}. The demo re-verifies against an anchored fixture; if the most recent match days have rotated out of <code>daily_scores_roots</code> it retries automatically. Refresh in a moment, or run <code style={{ fontFamily: MONO }}>node scripts_judge-verify-fraud.mjs</code> yourself.
          </div>
        )}

        {!d && !err && <div style={{ marginTop: 30, color: MUT, fontFamily: MONO, fontSize: 14 }}>Simulating both settlements against the live oracle…</div>}

        {d && (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 30 }}>
              <div style={card(GREEN)}>
                <div style={{ font: `700 11px/1 ${MONO}`, letterSpacing: ".12em", color: GREEN }}>① THE REAL SIGNED PROOF</div>
                <div style={{ fontSize: 40, fontWeight: 800, color: GREEN, margin: "12px 0 4px", lineHeight: 1 }}>TRUE</div>
                <p style={{ margin: "8px 0 0", fontSize: 15, lineHeight: 1.5, color: "#2a2f34" }}>The oracle re-verified TxLINE&apos;s signed Merkle proof against the anchored daily-scores root and returned <b>true</b>. GAFFER&apos;s kernel pays <b>only</b> on true — so this pool pays out.</p>
                <div style={{ marginTop: 12, font: `600 12px/1.4 ${MONO}`, color: MUT }}>validate_stat → true · {d.real.cu?.toLocaleString()} CU</div>
              </div>
              <div style={card(RED)}>
                <div style={{ font: `700 11px/1 ${MONO}`, letterSpacing: ".12em", color: RED }}>② ONE BYTE FLIPPED</div>
                <div style={{ fontSize: 40, fontWeight: 800, color: RED, margin: "12px 0 4px", lineHeight: 1 }}>REJECTED</div>
                <p style={{ margin: "8px 0 0", fontSize: 15, lineHeight: 1.5, color: "#2a2f34" }}>Change a single byte of the proof and the re-derived root no longer matches the anchored one — the oracle refuses it{d.forged.err ? <> (<code style={{ fontFamily: MONO }}>{d.forged.err.replace(/[{}[\]"]/g, "").slice(0, 40)}</code>)</> : ""}. No payout. The settler has no way to force a result it can&apos;t prove.</p>
                <div style={{ marginTop: 12, font: `600 12px/1.4 ${MONO}`, color: MUT }}>validate_stat → rejected · {d.forged.cu?.toLocaleString()} CU</div>
              </div>
            </div>

            <div style={{ marginTop: 20, background: "#08130d", color: "#d8dee2", borderRadius: 16, padding: "24px 26px" }}>
              <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.4 }}>Same proof. One byte changed. <span style={{ color: "#6ee7b7" }}>The chain caught it.</span></div>
              <p style={{ margin: "10px 0 0", fontSize: 14.5, lineHeight: 1.55, color: "rgba(255,255,255,.72)" }}>
                Settlement is a CPI into TxLINE&apos;s <code style={{ fontFamily: MONO, color: "#fff" }}>validate_stat</code>, which re-verifies the signed proof against the root TxODDS anchored on Solana — inside the settle transaction itself. Cranking is permissionless precisely because a forged proof just fails. There is no privileged party who <i>could</i> post a false result.
              </p>
            </div>

            <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr", gap: 2, border: `1px solid ${LINE}`, background: LINE, borderRadius: 14, overflow: "hidden" }}>
              {[
                ["Fixture", `#${d.fixtureId} · seq ${d.seq}`],
                ["Predicate checked", `stat key ${d.statKey} = ${d.statValue}  (value > 0)`],
                ["TxLINE oracle", <a key="o" href={EX(d.oracle)} target="_blank" rel="noopener" style={{ color: GREEN, fontFamily: MONO, fontSize: 13, textDecoration: "none" }}>{d.oracle} ↗</a>],
                ["Anchored root (daily_scores_roots)", <a key="d" href={EX(d.dsr)} target="_blank" rel="noopener" style={{ color: GREEN, fontFamily: MONO, fontSize: 13, textDecoration: "none" }}>{d.dsr} ↗</a>],
              ].map(([k, v], i) => (
                <div key={i} style={{ background: "#fff", padding: "13px 18px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <span style={{ font: `600 12px/1.5 ${MONO}`, letterSpacing: ".06em", textTransform: "uppercase", color: MUT }}>{k}</span>
                  <span style={{ fontSize: 14, textAlign: "right" }}>{v as any}</span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 22 }}>
              <div style={{ ...eyebrow, marginBottom: 8 }}>Verify it yourself · zero credentials</div>
              <pre style={{ margin: 0, background: "#08130d", color: "#9fe7c4", padding: "16px 18px", borderRadius: 12, overflowX: "auto", font: `500 13px/1.6 ${MONO}` }}>{`cd web
node scripts_judge-verify-fraud.mjs        # real proof → TRUE, forged → rejected, from public devnet
`}</pre>
              <p style={{ margin: "12px 0 0", fontSize: 13.5, color: MUT }}>The script fetches the same signed proof from <code style={{ fontFamily: MONO }}>/api/proof</code>, rebuilds the exact <code style={{ fontFamily: MONO }}>validate_stat</code> call the kernel makes, and simulates both against the public RPC — nothing here is trusted or spent.</p>
            </div>

            <div style={{ marginTop: 30 }}>
              <a href="/proof-deck.html" style={{ color: INK, fontWeight: 600, fontSize: 15, textDecoration: "none", borderBottom: `2px solid ${GREEN}` }}>← Back to the proof deck</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
