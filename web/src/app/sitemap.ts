import type { MetadataRoute } from "next";

/** The two pages a person can actually land on: the app, and the page that explains it. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://gaffer-cyan.vercel.app";
  return [
    { url: base, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/landing`, changeFrequency: "weekly", priority: 0.8 },
  ];
}
