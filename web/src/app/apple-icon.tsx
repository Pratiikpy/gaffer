import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon — the GAFFER mark (the same SVG the app header draws), ink on the app's paper. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "180px", height: "180px", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAFAF7" }}>
        <svg viewBox="0 0 64 64" width="118" height="118" fill="none">
          <circle cx="32" cy="32" r="22" stroke="#0A0A0A" strokeWidth="6.5" />
          <line x1="32" y1="6" x2="32" y2="58" stroke="#0A0A0A" strokeWidth="6.5" />
          <circle cx="32" cy="32" r="6" fill="#0A0A0A" />
        </svg>
      </div>
    ),
    size
  );
}
