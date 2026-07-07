import { ImageResponse } from "next/og";

export const runtime = "edge";

/** The GAFFER app icon (the circle-with-centre-line mark on the brand dark-green) at any size — powers
 * the PWA manifest icons and the home-screen tile. `?size=` sets the square edge; `?maskable=1` adds the
 * safe-area padding Android needs so the mark isn't clipped inside a squircle. */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const size = Math.min(1024, Math.max(48, Number(p.get("size") || 512)));
  const maskable = p.get("maskable") === "1";
  const pad = maskable ? size * 0.18 : size * 0.12;
  const d = size - pad * 2;             // mark diameter
  const stroke = Math.max(4, d * 0.10);

  return new ImageResponse(
    (
      <div style={{ width: `${size}px`, height: `${size}px`, display: "flex", alignItems: "center", justifyContent: "center", background: "#05100b" }}>
        <div style={{ position: "relative", width: `${d}px`, height: `${d}px`, display: "flex" }}>
          {/* ring */}
          <div style={{ position: "absolute", inset: "0", borderRadius: "50%", border: `${stroke}px solid #ffffff`, display: "flex" }} />
          {/* centre line */}
          <div style={{ position: "absolute", top: "0", bottom: "0", left: `${d / 2 - stroke / 2}px`, width: `${stroke}px`, background: "#ffffff", display: "flex" }} />
          {/* centre dot */}
          <div style={{ position: "absolute", top: `${d / 2 - d * 0.11}px`, left: `${d / 2 - d * 0.11}px`, width: `${d * 0.22}px`, height: `${d * 0.22}px`, borderRadius: "50%", background: "#05100b", border: `${stroke}px solid #ffffff`, display: "flex" }} />
        </div>
      </div>
    ),
    { width: size, height: size }
  );
}
