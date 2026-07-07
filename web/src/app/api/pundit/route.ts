import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** THE GAFFER'S TAKE — an AI pundit that reacts to real TxLINE match events. A moment (goal / card /
 * big chance / VAR verdict / odds swing) comes in, a one-line hot take comes out, in a distinct
 * opinionated-pundit voice. Server-side so the model key never touches the browser; cached per moment
 * so the same event isn't re-generated; and it ALWAYS returns a line (templated fallback) so the live
 * commentary never goes blank. This is the track's "AI Pundit" idea, wired to our real feed. */

const NIM = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "meta/llama-3.1-70b-instruct"; // verified live on NIM

const cache = new Map<string, { at: number; line: string }>();

// Never-blank fallback: a templated pundit line per moment type, used if the model is slow/unset.
function fallback(kind: string, who: string): string {
  const f: Record<string, string> = {
    goal: `${who} find the net — and you can feel the belief surging through this side.`,
    red: `Down to ten. ${who} have a mountain to climb now, and they know it.`,
    booking: `Into the book he goes — the referee had seen enough of that.`,
    chance: `Oh, that's a huge chance! ${who} will wonder how that stayed out.`,
    var: `The referee's at the monitor — everything stops, and the whole ground holds its breath.`,
    verdict_stands: `It stands! ${who} get their goal, and the place erupts.`,
    verdict_overturned: `Chalked off! The flag's up, and ${who} can't believe it.`,
    odds: `The market's just lurched — someone knows something we don't.`,
  };
  return f[kind] || `Something's stirring here — this match has a real edge to it now.`;
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const kind = String(b.kind || "chance");
    const home = String(b.home || "the home side"), away = String(b.away || "the away side");
    const who = String(b.who || home), minute = String(b.minute || "");
    const detail = String(b.detail || "").slice(0, 160);
    const sig = `${kind}|${who}|${minute}|${detail}`;
    const hit = cache.get(sig);
    if (hit && Date.now() - hit.at < 10 * 60_000) return NextResponse.json({ line: hit.line, cached: true });

    const key = process.env.NVIDIA_API_KEY;
    if (!key) return NextResponse.json({ line: fallback(kind, who), source: "fallback" });

    const prompt = `Match: ${home} vs ${away}. Moment${minute ? ` (${minute})` : ""}: ${detail || kind}. Give your one-line hot take.`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000); // keep the live feed snappy — fall back if slow
    try {
      const r = await fetch(NIM, {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: "You are The Gaffer: a witty, sharp, opinionated football (soccer) pundit on a live match show. Reply with ONE punchy sentence, max 18 words. No emojis, no hashtags, no quotation marks. Sound like live TV co-commentary." },
            { role: "user", content: prompt },
          ],
          max_tokens: 60, temperature: 0.9, top_p: 0.95,
        }),
      });
      clearTimeout(timer);
      const j = await r.json();
      let line: string = j?.choices?.[0]?.message?.content?.trim() || "";
      line = line.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").slice(0, 200);
      if (!line) line = fallback(kind, who);
      cache.set(sig, { at: Date.now(), line });
      return NextResponse.json({ line, source: "nim" });
    } catch {
      clearTimeout(timer);
      return NextResponse.json({ line: fallback(kind, who), source: "fallback" });
    }
  } catch {
    return NextResponse.json({ line: "This one's bubbling up nicely.", source: "error" });
  }
}
