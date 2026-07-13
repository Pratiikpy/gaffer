import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Favicon / tab icon — the GAFFER mark (the same SVG the app header draws), generated so there's no binary in the repo. */
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "64px", height: "64px", display: "flex", alignItems: "center", justifyContent: "center", background: "#FAFAF7", borderRadius: "12px" }}>
        <svg viewBox="0 0 64 64" width="46" height="46" fill="none">
          <circle cx="32" cy="32" r="22" stroke="#0A0A0A" strokeWidth="7" />
          <line x1="32" y1="6" x2="32" y2="58" stroke="#0A0A0A" strokeWidth="7" />
          <circle cx="32" cy="32" r="6" fill="#0A0A0A" />
        </svg>
      </div>
    ),
    size
  );
}
