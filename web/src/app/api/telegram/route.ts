import { NextRequest, NextResponse } from "next/server";
import { verifyInitData, telegramUserId } from "@/lib/telegram";
import { ensureUserToken, grantNewAccount } from "@/lib/points";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Telegram mini-app sign-in. The shell posts the `initData` Telegram gave it; we verify the bot-token
 * signature and mint the same per-user points token the web shell uses. One backend, three shells. */
export async function POST(req: NextRequest) {
  try {
    const { initData } = await req.json();
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!botToken) return NextResponse.json({ error: "Telegram sign-in isn't configured." }, { status: 503 });

    const v = verifyInitData(String(initData || ""), botToken);
    if (!v.ok || !v.user) return NextResponse.json({ error: "unauthorized", reason: v.reason }, { status: 401 });

    const userId = telegramUserId(v.user.id, botToken);
    await grantNewAccount(userId);
    const { token } = await ensureUserToken(userId);
    return NextResponse.json({ userId, token, name: v.user.firstName || v.user.username || "Player" });
  } catch {
    return NextResponse.json({ error: "That didn't go through — try again." }, { status: 500 });
  }
}
