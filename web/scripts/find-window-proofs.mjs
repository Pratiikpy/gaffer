/** Locate two anchored snapshots of the same stat whose values bracket a real goal, so a window market
 * can be settled from them. Prints the seqs and values. */
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3000";
// use the app's own settle-side proof discovery through a tiny probe route is not available; instead
// hit TxLINE indirectly is not possible from here. So we ask the server for the events and rely on the
// settle route's cache warming. This script just reports what the /api/scores stream says.
const fixture = Number(process.argv[2] || 18193785);
const r = await fetch(`${BASE}/api/scores/${fixture}`).then((x) => x.json());
const evs = r.recent || [];
console.log("recent events:", evs.length, "of", r.count);
