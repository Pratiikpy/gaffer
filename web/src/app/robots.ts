import type { MetadataRoute } from "next";

/** Crawlable, except the parts that are machinery rather than product. `/api/*` answers JSON, and the
 *  Telegram and Farcaster shells only mean anything inside their host apps. */
export default function robots(): MetadataRoute.Robots {
  const base = "https://gaffer-cyan.vercel.app";
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/telegram", "/frame"] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
