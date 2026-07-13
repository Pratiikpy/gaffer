import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Farcaster mini-app manifest. A client fetches this to learn the app exists, what it looks like,
 * and where to open it. `accountAssociation` is the signed proof that this domain belongs to a Farcaster
 * account; it is issued by the owner from Warpcast and injected from the environment, never invented
 * here — an unsigned manifest is simply an unverified app, and pretending otherwise would be a lie. */
export async function GET() {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "https://www.mygaffer.xyz";

  const accountAssociation = process.env.FARCASTER_HEADER && process.env.FARCASTER_PAYLOAD && process.env.FARCASTER_SIGNATURE
    ? {
        header: process.env.FARCASTER_HEADER,
        payload: process.env.FARCASTER_PAYLOAD,
        signature: process.env.FARCASTER_SIGNATURE,
      }
    : undefined;

  return NextResponse.json({
    ...(accountAssociation ? { accountAssociation } : {}),
    frame: {
      version: "1",
      name: "GAFFER",
      iconUrl: `${base}/icon`,
      homeUrl: `${base}/frame`,
      imageUrl: `${base}/api/og`,
      buttonTitle: "Call it",
      splashImageUrl: `${base}/icon`,
      splashBackgroundColor: "#FAFAF7",
      subtitle: "Call it. Get paid.",
      description: "The World Cup game you already play in the group chat — now real, and it settles itself.",
      primaryCategory: "games",
    },
  });
}
