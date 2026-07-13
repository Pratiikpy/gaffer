import type { Metadata, Viewport } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "flag-icons/css/flag-icons.min.css";
import { Providers } from "./providers";

const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const jbmono = JetBrains_Mono({ variable: "--font-jbmono", subsets: ["latin"], weight: ["400", "500", "600"] });

const SITE = "https://www.mygaffer.xyz";
const TITLE = "GAFFER — call it, get paid the second it happens";
const DESC = "The World Cup game you already play in the group chat — now real, and it settles itself.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESC,
  applicationName: "GAFFER",
  openGraph: {
    title: TITLE, description: DESC, url: SITE, siteName: "GAFFER", type: "website",
    images: [{ url: "/api/og", width: 1200, height: 630, alt: "GAFFER — call it, get paid the second it happens" }],
  },
  twitter: {
    card: "summary_large_image", title: TITLE, description: DESC, images: ["/api/og"],
  },
  appleWebApp: { capable: true, title: "GAFFER", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#05100b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${outfit.variable} ${jbmono.variable} antialiased`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
