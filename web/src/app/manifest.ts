import type { MetadataRoute } from "next";

/** PWA manifest — makes GAFFER installable to the home screen and launch full-screen like a native app.
 * Icons are rendered on demand by /api/icon so there are no binary blobs to keep in the repo. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GAFFER — World Cup",
    short_name: "GAFFER",
    description: "Call it, get paid the second it happens. The World Cup game you already play in the group chat.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#05100b",
    theme_color: "#05100b",
    categories: ["sports", "games", "entertainment"],
    icons: [
      { src: "/api/icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/icon?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/api/icon?size=192&maskable=1", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/api/icon?size=512&maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
