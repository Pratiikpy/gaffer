import { ImageResponse } from "next/og";

export const runtime = "edge";

/** The GAFFER app icon — the exact mark the app header draws (circle + centre line + dot), ink on the
 * app's paper — at any size. Powers the PWA manifest icons and the home-screen tile. `?size=` sets the
 * square edge; `?maskable=1` adds the safe-area padding Android needs so the mark isn't clipped inside
 * a squircle. */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const size = Math.min(1024, Math.max(48, Number(p.get("size") || 512)));
  const maskable = p.get("maskable") === "1";
  const pad = maskable ? size * 0.18 : size * 0.12;
  const d = Math.round(size - pad * 2); // mark edge

  return new ImageResponse(
    (
      <div style={{ width: `${size}px`, height: `${size}px`, display: "flex", alignItems: "center", justifyContent: "center", background: "#FAFAF7" }}>
        <svg viewBox="0 0 64 64" width={d} height={d} fill="none">
          <circle cx="32" cy="32" r="22" stroke="#0A0A0A" strokeWidth="6.5" />
          <line x1="32" y1="6" x2="32" y2="58" stroke="#0A0A0A" strokeWidth="6.5" />
          <circle cx="32" cy="32" r="6" fill="#0A0A0A" />
        </svg>
      </div>
    ),
    { width: size, height: size }
  );
}
