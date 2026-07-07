import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon — the GAFFER mark on brand green for the iOS home screen. */
export default function AppleIcon() {
  const d = 132, stroke = 14;
  return new ImageResponse(
    (
      <div style={{ width: "180px", height: "180px", display: "flex", alignItems: "center", justifyContent: "center", background: "#05100b" }}>
        <div style={{ position: "relative", width: `${d}px`, height: `${d}px`, display: "flex" }}>
          <div style={{ position: "absolute", inset: "0", borderRadius: "50%", border: `${stroke}px solid #ffffff`, display: "flex" }} />
          <div style={{ position: "absolute", top: "0", bottom: "0", left: `${d / 2 - stroke / 2}px`, width: `${stroke}px`, background: "#ffffff", display: "flex" }} />
          <div style={{ position: "absolute", top: `${d / 2 - d * 0.11}px`, left: `${d / 2 - d * 0.11}px`, width: `${d * 0.22}px`, height: `${d * 0.22}px`, borderRadius: "50%", background: "#05100b", border: `${stroke}px solid #ffffff`, display: "flex" }} />
        </div>
      </div>
    ),
    size
  );
}
