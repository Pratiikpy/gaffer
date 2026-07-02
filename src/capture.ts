/**
 * Tick-vault capture daemon (G1) — records the complete TxLINE scores + odds firehose, permanently.
 *
 * Every `data:` event from `/api/scores/stream` and `/api/odds/stream` is appended, with a local
 * receive timestamp, to day-rotated JSONL files. This corpus drives the replay engine (staged demos,
 * Mystery Match, Drama Meter tuning) — a match that isn't captured is gone forever, so this runs
 * continuously for the rest of the tournament.
 *
 *   npm run capture            (data → ./tick-vault, gitignored; override with TICK_VAULT)
 *
 * Resilient: reconnects with backoff, re-authenticates on 401, resumes the odds stream with
 * Last-Event-ID, rotates files at UTC midnight, and writes a status heartbeat every 30s.
 */
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { TxlineClient } from "./txline";

const API = process.env.TXLINE_API || "https://txline-dev.txodds.com";
const RPC = process.env.RPC || "https://api.devnet.solana.com";
const VAULT = process.env.TICK_VAULT || path.join(__dirname, "..", "tick-vault");
const STATUS = path.join(VAULT, "capture-status.json");

fs.mkdirSync(VAULT, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const utcDay = () => new Date().toISOString().slice(0, 10);

const stats: Record<string, { events: number; lastEventAt: number; reconnects: number }> = {
  scores: { events: 0, lastEventAt: 0, reconnects: 0 },
  odds: { events: 0, lastEventAt: 0, reconnects: 0 },
};

function appendEvent(stream: "scores" | "odds", rawData: string) {
  const file = path.join(VAULT, `${stream}-${utcDay()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ r: Date.now(), d: rawData }) + "\n");
  stats[stream].events++;
  stats[stream].lastEventAt = Date.now();
}

/** ONE shared authenticated client for both streams. Two concurrent auth flows race the subscribe/
 * activate steps (observed: second flow 403s), so authentication is serialized behind a single
 * promise; `getClient(true)` swaps in a fresh session when a token expires. */
let clientP: Promise<TxlineClient> | null = null;
function getClient(force = false): Promise<TxlineClient> {
  if (!clientP || force) {
    clientP = (async () => {
      const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".devnet-key.json"), "utf8"))));
      const c = new TxlineClient(new Connection(RPC, "confirmed"), kp);
      await c.authenticate();
      log("TxLINE authenticated");
      return c;
    })();
    clientP.catch(() => { clientP = null; }); // a failed auth must not poison future attempts
  }
  return clientP;
}

/** One long-lived SSE consumer; returns when the stream ends/errors (caller reconnects). */
async function consume(c: TxlineClient, stream: "scores" | "odds", lastId: { v: string }): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${(c as any).jwt}`, "X-Api-Token": (c as any).apiToken,
    Accept: "text/event-stream", "Cache-Control": "no-cache",
  };
  if (stream === "odds" && lastId.v) headers["Last-Event-ID"] = lastId.v; // resume without gaps
  const res = await fetch(`${API}/api/${stream}/stream`, { headers });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`auth ${res.status}`), { reauth: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  log(`${stream} stream connected (HTTP ${res.status})`);
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) appendEvent(stream, line.slice(5).trim());
      else if (line.startsWith("id:")) lastId.v = line.slice(3).trim();
      // heartbeats and blank lines keep the connection alive; nothing to store
    }
  }
}

/** Run one stream forever: reconnect with backoff, re-auth when the token expires. Nothing here is
 * fatal — auth failures, stream errors, and server closes all funnel into the same retry loop. */
async function runStream(stream: "scores" | "odds") {
  const lastId = { v: "" };
  let backoff = 5_000;
  for (;;) {
    try {
      const c = await getClient();
      await consume(c, stream, lastId);
      log(`${stream} stream closed by server — reconnecting`);
      backoff = 5_000;
    } catch (e: any) {
      log(`${stream} stream error: ${e.message} — retry in ${backoff / 1000}s`);
      if (e.reauth) getClient(true).catch(() => {}); // refresh the shared session for the next attempt
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
    stats[stream].reconnects++;
  }
}

setInterval(() => {
  fs.writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, day: utcDay(), stats }, null, 2));
}, 30_000);

log(`tick-vault capture starting → ${VAULT}`);
// runStream never returns and never throws (everything funnels into its retry loop).
runStream("scores");
runStream("odds");
