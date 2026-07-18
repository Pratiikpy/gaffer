"use client";
import { useEffect, useState } from "react";

/** Judge/Track-3 surface: the six autonomous agents, live. Polls /api/fleet (the droplet's heartbeat)
 * so you can watch them working right now — which match each is on, and the real last line it emitted. */

const INK = "#0A0A0A", BG = "#FAFAF7", GREEN = "#0E9F5B", MUT = "#6B7280", LINE = "rgba(10,10,10,.10)", DIM = "#9CA3AF";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

type Agent = { name: string; label: string; blurb: string; running: boolean; fixture: number | null; upMs: number | null; last: string | null };
type Fleet = { live: boolean; ageMs: number | null; uptimeMs: number | null; host?: string; fixtures: number[]; agents: Agent[]; error?: string };

const dur = (ms: number | null) => { if (!ms || ms < 0) return "—"; const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; };

function Mark({ size = 30 }: { size?: number }) {
  return (<svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden><circle cx="32" cy="32" r="22" stroke={INK} strokeWidth="6.5" /><line x1="32" y1="6" x2="32" y2="58" stroke={INK} strokeWidth="6.5" /><circle cx="32" cy="32" r="6" fill={INK} /></svg>);
}

export default function FleetPage() {
  const [f, setF] = useState<Fleet | null>(null);
  const [ear, setEar] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    let on = true;
    const load = () => {
      fetch("/api/fleet").then((r) => r.json()).then((j) => on && setF(j)).catch(() => {});
      fetch("/api/ear-record").then((r) => r.json()).then((j) => on && setEar(j)).catch(() => {});
      fetch("/api/stats").then((r) => r.json()).then((j) => on && setStats(j)).catch(() => {});
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { on = false; clearInterval(t); };
  }, []);

  const wrap: React.CSSProperties = { minHeight: "100dvh", background: BG, color: INK, fontFamily: "'Outfit', system-ui, sans-serif", padding: "48px 22px 90px" };
  const page: React.CSSProperties = { maxWidth: 900, margin: "0 auto" };
  const eyebrow: React.CSSProperties = { font: `600 12px/1.5 ${MONO}`, letterSpacing: ".16em", textTransform: "uppercase", color: GREEN };
  const tile: React.CSSProperties = { flex: 1, minWidth: 150, border: `1px solid ${LINE}`, borderRadius: 14, padding: "16px 18px", background: "#fff" };

  const earRate = ear?.goalHitRate == null ? null : Math.round(ear.goalHitRate * 100);

  return (
    <div style={wrap}>
      <div style={page}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Mark /><div style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-.02em" }}>gaffer<span style={{ color: GREEN }}>.</span></div></div>
        <div style={{ ...eyebrow, marginTop: 26 }}>Trading Tools &amp; Agents · the fleet, live</div>
        <h1 style={{ fontSize: "clamp(30px,5vw,46px)", fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.03, margin: "12px 0 14px", maxWidth: "20ch" }}>Six autonomous agents, working right now.</h1>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          {f && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, font: `700 13px/1 ${MONO}`, color: f.live ? GREEN : DIM }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: f.live ? GREEN : DIM, boxShadow: f.live ? `0 0 0 0 ${GREEN}55` : "none", animation: f.live ? "fp 2s infinite" : "none" }} />
              {f.live ? "FLEET LIVE" : "FLEET OFFLINE"}
            </span>
          )}
          {f?.uptimeMs != null && <span style={{ font: `600 12px/1 ${MONO}`, color: MUT }}>up {dur(f.uptimeMs)}</span>}
          {f?.ageMs != null && <span style={{ font: `600 12px/1 ${MONO}`, color: MUT }}>· heartbeat {dur(f.ageMs)} ago</span>}
          {f?.host && <span style={{ font: `600 12px/1 ${MONO}`, color: MUT }}>· {f.host}</span>}
        </div>
        <style>{`@keyframes fp{0%{box-shadow:0 0 0 0 ${GREEN}55}70%{box-shadow:0 0 0 7px ${GREEN}00}100%{box-shadow:0 0 0 0 ${GREEN}00}}`}</style>

        {!f && <div style={{ marginTop: 26, color: MUT, fontFamily: MONO, fontSize: 14 }}>Reading the fleet heartbeat…</div>}

        {f && !f.live && (
          <p style={{ fontSize: 15, lineHeight: 1.5, color: MUT, maxWidth: "64ch" }}>
            No heartbeat in the last two minutes. The fleet runs on a droplet under systemd (<code style={{ fontFamily: MONO }}>Restart=always</code>) and parks between matches — if no World Cup fixture is live or kicking off soon, the agents idle until the next kickoff. The graded record below stays live regardless.
          </p>
        )}

        {/* tiles */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 22 }}>
          <div style={tile}><div style={{ fontSize: 26, fontWeight: 800 }}>{f?.agents?.filter((a) => a.running).length ?? "—"}<span style={{ fontSize: 15, color: MUT }}> / 6</span></div><div style={{ fontSize: 12.5, color: MUT, marginTop: 4 }}>agents running now</div></div>
          <div style={tile}><div style={{ fontSize: 26, fontWeight: 800, color: GREEN }}>{earRate == null ? "—" : `${earRate}%`}</div><div style={{ fontSize: 12.5, color: MUT, marginTop: 4 }}>the Ear · {ear?.goalConfirmed ?? "—"}/{ear?.goalCalls ?? "—"} goal calls</div></div>
          <div style={tile}><div style={{ fontSize: 26, fontWeight: 800 }}>{ear?.onChain ?? "—"}</div><div style={{ fontSize: 12.5, color: MUT, marginTop: 4 }}>calls committed on-chain</div></div>
          <div style={tile}><div style={{ fontSize: 26, fontWeight: 800 }}>{stats?.settled ?? "—"}</div><div style={{ fontSize: 12.5, color: MUT, marginTop: 4 }}>pools settled (kernel)</div></div>
        </div>

        {/* agent rows */}
        <div style={{ marginTop: 22, border: `1px solid ${LINE}`, borderRadius: 16, overflow: "hidden", background: "#fff" }}>
          {(f?.agents || []).map((a, i) => (
            <div key={a.name} style={{ padding: "16px 18px", borderTop: i ? `1px solid ${LINE}` : "none", display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span style={{ marginTop: 5, width: 9, height: 9, borderRadius: "50%", flex: "none", background: a.running ? GREEN : DIM }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 15.5 }}>{a.label}</span>
                  <span style={{ font: `600 11px/1.4 ${MONO}`, color: a.running ? GREEN : DIM }}>{a.running ? `on #${a.fixture} · up ${dur(a.upMs)}` : "idle"}</span>
                </div>
                <div style={{ fontSize: 13.5, color: MUT, marginTop: 2 }}>{a.blurb}</div>
                {a.last && <div style={{ marginTop: 8, font: `500 12px/1.5 ${MONO}`, color: "#2a2f34", background: "#F6F6F1", border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px", overflowX: "auto", whiteSpace: "nowrap" }}>{a.last}</div>}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 22 }}>
          <div style={{ ...eyebrow, marginBottom: 8 }}>Verify it yourself · zero credentials</div>
          <pre style={{ margin: 0, background: "#08130d", color: "#9fe7c4", padding: "16px 18px", borderRadius: 12, overflowX: "auto", font: `500 13px/1.6 ${MONO}` }}>{`cd web
node scripts_judge-verify-ear.mjs          # re-checks the Ear's on-chain calls + graded record
node ../agents/ear.mjs --selftest          # the Ear's deterministic decision core: 11/11
`}</pre>
        </div>

        <div style={{ marginTop: 28 }}>
          <a href="/proof-deck.html" style={{ color: INK, fontWeight: 600, fontSize: 15, textDecoration: "none", borderBottom: `2px solid ${GREEN}` }}>← Back to the proof deck</a>
        </div>
      </div>
    </div>
  );
}
