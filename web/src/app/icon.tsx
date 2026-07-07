import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Favicon / tab icon — the GAFFER mark, generated so there's no binary in the repo. */
export default function Icon() {
  const d = 48, stroke = 6;
  return new ImageResponse(
    (
      <div style={{ width: "64px", height: "64px", display: "flex", alignItems: "center", justifyContent: "center", background: "#05100b" }}>
        <div style={{ position: "relative", width: `${d}px`, height: `${d}px`, display: "flex" }}>
          <div style={{ position: "absolute", inset: "0", borderRadius: "50%", border: `${stroke}px solid #ffffff`, display: "flex" }} />
          <div style={{ position: "absolute", top: "0", bottom: "0", left: `${d / 2 - stroke / 2}px`, width: `${stroke}px`, background: "#ffffff", display: "flex" }} />
        </div>
      </div>
    ),
    size
  );
}
