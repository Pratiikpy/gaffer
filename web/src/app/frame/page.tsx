import type { Metadata } from "next";
import GafferApp from "@/components/GafferApp";
import FarcasterReady from "./ready";

/** The Farcaster shell.
 *
 * Same app, same `/api`, same kernel — a shell, not a fork. The page carries the `fc:miniapp` embed so a
 * cast renders as a launchable card, and calls the SDK's `ready()` once mounted so the client dismisses
 * its splash. Money identity remains the wallet, exactly as on web and in Telegram.
 */

const BASE = process.env.NEXT_PUBLIC_BASE_URL || "https://www.mygaffer.xyz";

const embed = {
  version: "1",
  imageUrl: `${BASE}/api/og`,
  button: {
    title: "Call it",
    action: { type: "launch_frame", name: "GAFFER", url: `${BASE}/frame`, splashImageUrl: `${BASE}/icon`, splashBackgroundColor: "#FAFAF7" },
  },
};

export const metadata: Metadata = {
  title: "GAFFER — call it, get paid the second it happens",
  description: "The World Cup game you already play in the group chat — now real, and it settles itself.",
  other: {
    // `fc:miniapp` is the current key; `fc:frame` is kept for clients that still read the old one.
    "fc:miniapp": JSON.stringify(embed),
    "fc:frame": JSON.stringify(embed),
  },
};

export default function FarcasterShell() {
  return (
    <>
      <FarcasterReady />
      <GafferApp />
    </>
  );
}
