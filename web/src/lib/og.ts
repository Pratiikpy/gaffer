import "server-only";

/** The 0G inference router — a model behind a TEE, reached over an OpenAI-shaped API.
 *
 * The key never leaves the server. Two details of this endpoint bite if you don't know them:
 *
 *  1. **Thinking is inline.** `minimax-m3` has reasoning on by default and emits it as a `<think>…</think>`
 *     block inside `message.content`, not in a separate `reasoning_content` field. Anything that parses
 *     content as JSON must strip it first. We avoid the whole problem by taking answers as tool calls.
 *  2. **`tool_choice: "required"`** makes the model answer in the grammar or refuse in the grammar. There
 *     is no third path where it writes an essay we then have to interpret.
 */

const API_URL = process.env.OG_API_URL || "https://router-api.0g.ai/v1/chat/completions";
const MODEL = process.env.OG_MODEL || "minimax-m3";
const KEY = process.env.OG_API_KEY || "";

export const ogConfigured = () => KEY.length > 0;

export type ToolSpec = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};
export type ToolCall = { name: string; args: Record<string, unknown> };

/** Strip the model's inline chain-of-thought. Never shown, never parsed, never stored. */
export const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export class OgError extends Error {}

/** Ask the model to answer strictly by calling one of `tools`. Returns the first call it makes.
 *
 * A refusal is a tool call too — the caller decides what each tool name means. Anything else (no call, a
 * malformed argument blob, a timeout, a dead router) throws, because a market compiler that guesses when
 * the model is silent is worse than one that says "try again". */
export async function toolCall(
  opts: { system: string; user: string; tools: ToolSpec[]; timeoutMs?: number; verifyTee?: boolean; maxTokens?: number },
): Promise<ToolCall> {
  if (!KEY) throw new OgError("inference is not configured");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 3000,   // reasoning tokens are billed from this budget too
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      tools: opts.tools,
      tool_choice: "required",
      ...(opts.verifyTee ? { verify_tee: true } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
  });

  if (!res.ok) throw new OgError(`inference router returned ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new OgError(String(body.error?.message || body.error).slice(0, 120));

  const message = body?.choices?.[0]?.message;
  const call = message?.tool_calls?.[0]?.function;
  if (!call?.name) throw new OgError("the model answered outside the grammar");

  let args: Record<string, unknown> = {};
  if (call.arguments) {
    try { args = JSON.parse(stripThinking(String(call.arguments))); }
    catch { throw new OgError("the model's arguments were not readable"); }
  }
  return { name: String(call.name), args };
}
