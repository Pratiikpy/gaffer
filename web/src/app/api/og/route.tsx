import { ImageResponse } from "next/og";

export const runtime = "edge";

/** Dynamic share image (1200×630). No params → the branded GAFFER card that fronts every shared link.
 * With ?amount&q&called&mult → a Proof-of-Payout receipt so a win pastes into a chat as a real card.
 * All values are display-only text passed by the sharer; the on-chain receipt link carries the proof.
 * NOTE: Satori (next/og) requires an explicit `display: flex` on every element with >1 child, and each
 * text node must be a single string — so every leaf below holds one template string, never mixed nodes. */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const amount = p.get("amount");
  const q = (p.get("q") || "").slice(0, 80);
  const called = p.get("called");
  const mult = p.get("mult");
  const isReceipt = !!amount;
  const stamp = called ? `Called at ${called}%${mult ? `  ·  paid ${mult}×` : ""}` : "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px", height: "630px", display: "flex", flexDirection: "column",
          justifyContent: "center", padding: "80px", color: "white", fontFamily: "sans-serif",
          background: isReceipt
            ? "radial-gradient(120% 90% at 50% 30%, #047857, #052e21)"
            : "radial-gradient(120% 90% at 30% 20%, #0b3b2a, #05100b)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ width: "40px", height: "40px", borderRadius: "50%", border: "6px solid white", display: "flex" }} />
          <div style={{ display: "flex", fontSize: "34px", fontWeight: 800, letterSpacing: "-1px" }}>gaffer.</div>
        </div>

        {isReceipt ? (
          <div style={{ display: "flex", flexDirection: "column", marginTop: "40px" }}>
            <div style={{ display: "flex", fontSize: "26px", letterSpacing: "6px", textTransform: "uppercase", color: "rgba(255,255,255,0.6)" }}>YOU CALLED IT</div>
            <div style={{ display: "flex", fontSize: "150px", fontWeight: 800, letterSpacing: "-4px", color: "#6ee7b7", lineHeight: 1 }}>{`+${amount}`}</div>
            <div style={{ display: "flex", fontSize: "32px", color: "rgba(255,255,255,0.85)", marginTop: "12px" }}>{q}</div>
            {stamp ? (
              <div style={{ display: "flex", marginTop: "26px" }}>
                <div style={{ display: "flex", fontSize: "28px", fontWeight: 700, background: "rgba(255,255,255,0.12)", padding: "12px 24px", borderRadius: "999px" }}>{stamp}</div>
              </div>
            ) : null}
            <div style={{ display: "flex", fontSize: "24px", color: "rgba(255,255,255,0.55)", marginTop: "28px" }}>Paid the second it happened — and we can prove it.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", marginTop: "44px" }}>
            <div style={{ display: "flex", fontSize: "84px", fontWeight: 800, letterSpacing: "-3px" }}>Call it.</div>
            <div style={{ display: "flex", fontSize: "84px", fontWeight: 800, letterSpacing: "-3px", lineHeight: 1.05 }}>Get paid the second it happens.</div>
            <div style={{ display: "flex", fontSize: "34px", color: "rgba(255,255,255,0.7)", marginTop: "30px", maxWidth: "1000px" }}>The World Cup game you already play in the group chat — now real, and it settles itself.</div>
          </div>
        )}
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
