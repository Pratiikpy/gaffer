import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { secretEq } from "@/lib/serverConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The autonomous fleet's live heartbeat. The droplet supervisor POSTs its state here every ~30s
 * (authed with the same EAR_COMMIT_SECRET the Ear commits with); the public GET reports whether the
 * fleet is live right now, which agents are on which fixtures, and each agent's last line of output.
 * Powers /fleet — the "watch the six agents working, right now" page. Read-only for everyone else.
 */
let ready = false;
async function ensure() {
  if (ready) return;
  await db()`CREATE TABLE IF NOT EXISTS fleet_heartbeat (id int PRIMARY KEY DEFAULT 1, payload jsonb NOT NULL, at bigint NOT NULL)`;
  ready = true;
}

export async function POST(req: NextRequest) {
  if (!secretEq(req.headers.get("x-ear-key") || "", process.env.EAR_COMMIT_SECRET || "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await ensure();
    const body = await req.json();
    const at = Date.now();
    await db()`INSERT INTO fleet_heartbeat (id, payload, at) VALUES (1, ${JSON.stringify(body)}::jsonb, ${at})
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, at = EXCLUDED.at`;
    return NextResponse.json({ ok: true, at });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}

const AGENTS = [
  { name: "detector", label: "Sharp-Move Detector", blurb: "flags a decisive one-sided repricing off the de-margined line" },
  { name: "market-maker", label: "In-Play Market Maker", blurb: "quotes two-sided prices and pulls them as the match moves" },
  { name: "clv-tracker", label: "CLV Tracker", blurb: "scores each call's closing-line value — the desk's sharpness metric" },
  { name: "arena", label: "Agent-vs-Agent Arena", blurb: "favourite vs underdog, settled on the real signed final score" },
  { name: "explainer", label: "The Gaffer's Read", blurb: "one honest line on what a live move means" },
  { name: "ear", label: "The Gaffer's Ear", blurb: "infers goals/stoppages from the odds alone, commits each on-chain" },
];

export async function GET() {
  try {
    await ensure();
    const rows = await db()`SELECT payload, at FROM fleet_heartbeat WHERE id = 1`;
    if (!rows.length) return NextResponse.json({ live: false, ageMs: null, agents: AGENTS.map((a) => ({ ...a, running: false })), fixtures: [], uptimeMs: null, at: null });
    const at = Number(rows[0].at);
    const p = rows[0].payload || {};
    const ageMs = Date.now() - at;
    const live = ageMs < 120_000; // a heartbeat within 2 min = the fleet is up
    const byName = new Map((p.agents || []).map((a: any) => [a.name, a]));
    const agents = AGENTS.map((a) => {
      const hit: any = byName.get(a.name);
      return { ...a, running: live && !!hit, fixture: hit?.fixture ?? null, upMs: hit?.up ?? null, last: hit?.last ?? null };
    });
    return NextResponse.json({ live, ageMs, at, uptimeMs: p.uptimeMs ?? null, host: p.host ?? null, fixtures: p.fixtures ?? [], agents });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || String(e)).slice(0, 120) }, { status: 500 });
  }
}
