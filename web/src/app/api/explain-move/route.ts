import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** THE GAFFER'S READ — an AI analyst that explains a live move in the de-margined market, in one plain
 * sentence a fan or a trader can act on. It is fed a REAL, measured swing in TxLINE's implied-% line
 * (side, from, to) and explains what a move that size signals.
 *
 * It is deliberately honest about the one thing it cannot see: the dev feed does not stream live score
 * events, so the analyst explains the MARKET (which is live and real) and never asserts a specific goal
 * or card it has no evidence for. "The line jumped 8 points onto Spain" is fact; "Spain just scored" is
 * a claim it must not make. The system prompt enforces that. Server-side so the model key never reaches
 * the browser; always returns a line (templated fallback) so the read never goes blank. */

const NIM = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "meta/llama-3.1-70b-instruct";

const cache = new Map<string, { at: number; line: string }>();

// The cache only helps repeated identical moves; a caller varying `from`/`to` by a point bypasses it and
// hits the paid model every time. Throttle per IP, like /api/compile-market, since inference costs money.
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now(), win = hits.get(ip)?.filter((t) => now - t < 60_000) ?? [];
  if (win.length >= 12) { hits.set(ip, win); return true; }
  win.push(now); hits.set(ip, win); return false;
}

const teamFor = (side: string, home: string, away: string) => (side === "home" ? home : side === "away" ? away : "the draw");

/** Never-blank, and never dishonest: describes the measured move without inventing a cause. */
function fallback(side: string, delta: number, home: string, away: string): string {
  const team = teamFor(side, home, away);
  const dir = side === "draw" ? "toward a draw" : `onto ${team}`;
  if (delta >= 12) return `Big lurch ${dir} — ${delta} points in one tick. The market just repriced hard on something.`;
  if (delta >= 6) return `The line's moved ${delta} points ${dir} — sharper money is leaning in.`;
  return `A ${delta}-point drift ${dir} — the market's edging its read.`;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (throttled(ip)) return NextResponse.json({ line: "One read at a time — give it a second.", source: "throttled" }, { status: 429 });
    const b = await req.json();
    const home = String(b.home || "the home side"), away = String(b.away || "the away side");
    const side = ["home", "draw", "away"].includes(String(b.side)) ? String(b.side) : "home";
    const from = Math.round(Number(b.from) || 0), to = Math.round(Number(b.to) || 0);
    const delta = Math.abs(to - from);
    if (!delta) return NextResponse.json({ line: "The market's holding steady — no read to give yet.", source: "flat" });

    const sig = `${home}|${away}|${side}|${from}|${to}`;
    const hit = cache.get(sig);
    if (hit && Date.now() - hit.at < 10 * 60_000) return NextResponse.json({ line: hit.line, cached: true });

    const key = process.env.NVIDIA_API_KEY;
    if (!key) return NextResponse.json({ line: fallback(side, delta, home, away), source: "fallback" });

    const team = teamFor(side, home, away);
    const prompt = `Live de-margined market on ${home} v ${away}. The implied chance of ${team} just moved from ${from}% to ${to}% (${delta}-point swing). In ONE sentence, explain to a trader what a move this size usually means. You can see the market only — you did NOT see the match, so do not claim a specific goal, card, or event happened; talk about the money and the read, not an event you can't verify.`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(NIM, {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: "You are The Gaffer, a sharp trading analyst reading a live football betting market. Reply with ONE precise sentence, max 22 words. No emojis, hashtags, or quotation marks. Explain the market move and what it signals — never assert a specific match event (goal/card/VAR) you have not seen." },
            { role: "user", content: prompt },
          ],
          max_tokens: 70, temperature: 0.8, top_p: 0.95,
        }),
      });
      clearTimeout(timer);
      const j = await r.json();
      let line: string = j?.choices?.[0]?.message?.content?.trim() || "";
      line = line.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").slice(0, 220);
      if (!line) line = fallback(side, delta, home, away);
      cache.set(sig, { at: Date.now(), line });
      return NextResponse.json({ line, source: "nim", move: { side, from, to, delta } });
    } catch {
      clearTimeout(timer);
      return NextResponse.json({ line: fallback(side, delta, home, away), source: "fallback" });
    }
  } catch {
    return NextResponse.json({ line: "The market's stirring — a read is forming.", source: "error" });
  }
}
