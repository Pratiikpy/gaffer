/** Server-side TxLINE client. The subscription/api-token lives here, never in the browser.
 * A module singleton authenticates once and is reused across requests. */
import "server-only";
import axios, { AxiosInstance } from "axios";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { KeypairWallet } from "./wallet";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as nacl from "tweetnacl";
import { RPC, TXLINE_API, TXORACLE, SUB_MINT } from "./config";
import { loadServerKeypair } from "./serverConfig";
import { cached } from "./cache";
import txoracleIdl from "./txoracle.idl.json";

class TxlineServer {
  private jwt = "";
  private apiToken = "";
  private http: AxiosInstance;
  private payer: Keypair;
  private conn: Connection;
  private ready: Promise<void> | null = null;

  constructor() {
    this.conn = new Connection(RPC, "confirmed");
    this.payer = loadServerKeypair();
    this.http = axios.create({ baseURL: TXLINE_API, timeout: 30000, headers: { "Content-Type": "application/json" } });
  }

  /** Authenticate once per process; subsequent calls reuse the cached token.
   *
   * Getting a token costs a guest JWT, an on-chain `subscribe` transaction, and an activation round-trip.
   * A serverless cold start paid all three before it could read a single event — slow enough that the
   * first request to a fresh deployment failed, and it spent the server keypair's SOL on a new
   * subscription every time a lambda woke up. So the token is shared through Postgres: a cold instance
   * picks up the token the last one minted, and we only mint again when the old one stops working. */
  private async ensure(): Promise<void> {
    if (this.apiToken) return;
    if (!this.ready) this.ready = this.acquireToken();
    await this.ready;
  }

  /** Reuse a stored token if there is one; otherwise mint a fresh one and store it for the next lambda. */
  private async acquireToken(): Promise<void> {
    const stored = await this.loadToken().catch(() => null);
    if (stored) { await this.ensureJwt(); this.useToken(stored); return; }
    await this.authenticate();
    await this.saveToken(this.apiToken).catch(() => { /* a token we can't share still works here */ });
  }

  /** The API token is not sufficient on its own — every request also needs a guest JWT.
   *
   * `authenticate()` happens to set both, so this was invisible until the token started being shared:
   * a cold instance loaded the stored token, sent it with no `Authorization` header, got a 401, decided
   * the token had expired, and signed a brand-new on-chain `subscribe`. Four of them landed in one
   * keeper sweep. A guest JWT is free and instant; get one before using anybody's token. */
  private async ensureJwt(): Promise<void> {
    if (this.jwt) return;
    this.jwt = (await this.http.post("/auth/guest/start")).data.token;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.jwt}`;
  }

  private useToken(token: string) {
    this.apiToken = token;
    this.http.defaults.headers.common["X-Api-Token"] = token;
  }

  private async loadToken(): Promise<string | null> {
    const { db } = await import("./db");
    const rows = await db()`SELECT token FROM txline_token WHERE id = 1`;
    return rows[0]?.token ?? null;
  }

  private async saveToken(token: string): Promise<void> {
    const { db } = await import("./db");
    await db()`INSERT INTO txline_token (id, token, minted_at) VALUES (1, ${token}, ${Date.now()})
               ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, minted_at = EXCLUDED.minted_at`;
  }

  /** The stored token was rejected — mint a new one, once, and share it.
   *
   * Minting is not cheap and it is not private: it signs an on-chain `subscribe` to the TxODDS program
   * with the server keypair. Two guards, both learned the hard way. The in-flight promise means a burst
   * of concurrent 401s causes one re-subscription rather than one per request. And the cooldown means a
   * feed that answers 401 to *everything* cannot turn the keeper into a subscription mint — it would
   * empty the wallet a transaction at a time. */
  private reauth: Promise<void> | null = null;
  private lastMintAt = 0;
  private static readonly MINT_COOLDOWN_MS = 5 * 60_000;

  private async renew(): Promise<void> {
    if (Date.now() - this.lastMintAt < TxlineServer.MINT_COOLDOWN_MS) return; // too soon; let the call fail
    if (!this.reauth) {
      this.reauth = (async () => {
        // Somebody else may already have paid for this. Instances share the token through Postgres, so
        // before signing a subscription of our own, look whether a newer one has landed.
        const fresh = await this.loadToken().catch(() => null);
        if (fresh && fresh !== this.apiToken) { this.useToken(fresh); return; }

        this.lastMintAt = Date.now();
        this.apiToken = "";
        await this.authenticate();
        await this.saveToken(this.apiToken).catch(() => {});
      })().finally(() => { this.reauth = null; });
    }
    await this.reauth;
  }

  /** Run a feed call, and if the shared token has expired, mint a new one and try exactly once more.
   *
   * Only a 401 means "your token is no good". A 403 means "not this resource" — a fixture whose history
   * has aged out of the feed answers 403 forever, and treating that as an expired token made the keeper
   * sign a fresh on-chain `subscribe` on *every sweep of every dead pool*. Two subscriptions landed in
   * four minutes before this was caught. Authentication is about the caller; 403 is about the thing. */
  private async withToken<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensure();
    try {
      return await fn();
    } catch (e: any) {
      if (e?.response?.status !== 401) throw e;
      await this.renew();
      return await fn();
    }
  }

  private async authenticate(): Promise<void> {
    this.jwt = (await this.http.post("/auth/guest/start")).data.token;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.jwt}`;
    const provider = new AnchorProvider(this.conn, new KeypairWallet(this.payer), { commitment: "confirmed" });
    const prog: any = new Program(txoracleIdl as any, provider);
    const [pricing] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], TXORACLE);
    const [treas] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], TXORACLE);
    const vault = getAssociatedTokenAddressSync(SUB_MINT, treas, true, TOKEN_2022_PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(this.conn, this.payer, SUB_MINT, this.payer.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
    const subSig: string = await prog.methods.subscribe(1, 4).accounts({
      user: this.payer.publicKey, pricingMatrix: pricing, tokenMint: SUB_MINT, userTokenAccount: ata.address,
      tokenTreasuryVault: vault, tokenTreasuryPda: treas, tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    const msg = new TextEncoder().encode(`${subSig}::${this.jwt}`);
    const walletSignature = Buffer.from(nacl.sign.detached(msg, this.payer.secretKey)).toString("base64");
    const ar = (await axios.post(`${TXLINE_API}/api/token/activate`, { txSig: subSig, walletSignature, leagues: [] }, { headers: { Authorization: `Bearer ${this.jwt}` } })).data;
    this.useToken(ar.token || ar);
  }

  /** A finished match is a thousand-plus events, delivered as one SSE stream with no seq-range fetch.
   *
   * It is also the single hottest call in the app: the live pulse, the scores route, Hi-Lo, the market
   * compiler and the keeper (once per open market) all want the same fixture's events, often in the same
   * second. Un-coalesced, a keeper sweep alone re-streamed the same match a dozen times and TxLINE began
   * answering 502 — which surfaced as Hi-Lo returning 503 on a cold deployment, the first request a new
   * visitor makes.
   *
   * One stream per fixture per few seconds, shared by every caller, and a slightly stale event list
   * through a blip beats an error. Fresh enough for a live match: `settle` re-verifies every proof
   * on-chain regardless of what we read here. */
  async historicalEvents(fixtureId: number): Promise<any[]> {
    return cached(`events:${fixtureId}`, { ttlMs: 5_000, swrMs: 30_000, staleMs: 120_000 }, () => this.readEvents(fixtureId));
  }

  private async readEvents(fixtureId: number): Promise<any[]> {
    const raw: string = await this.withToken(async () =>
      (await this.http.get(`/api/scores/historical/${fixtureId}`, { transformResponse: (r) => r })).data);
    return (typeof raw === "string" ? raw : "")
      .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
      .filter(Boolean) as any[];
  }

  /** Point-in-time odds snapshot: the latest consensus line per market for a fixture (S1 — the 12%
   * Stamp). `asOf` (ms) pins a historical moment (the lock time). Each payload carries `Pct`
   * (de-margined implied %, "NA" on quarter lines) and a `MessageId` provable via /api/odds/validation. */
  async oddsSnapshot(fixtureId: number, asOf?: number): Promise<any[]> {
    try {
      const v = await this.withToken(async () => (await this.http.get(`/api/odds/snapshot/${fixtureId}`, { params: asOf ? { asOf } : {} })).data);
      return Array.isArray(v) ? v : (Array.isArray(v?.odds) ? v.odds : []);
    } catch { return []; }
  }

  /** The fixture schedule — today's real matches with names, competition and kickoff (the real-fixture
   * spine). Free devnet tier returns ~15 (WC + friendlies) in a +30d window from today. */
  async fixturesSnapshot(): Promise<any[]> {
    try {
      const v = await this.withToken(async () => (await this.http.get("/api/fixtures/snapshot")).data);
      return Array.isArray(v) ? v : (Array.isArray(v?.fixtures) ? v.fixtures : []);
    } catch { return []; }
  }

  /** Latest event per action type for a fixture — a fast way to read the current scoreline without
   * parsing the whole historical stream (38 entries for a finished match). */
  async scoresSnapshot(fixtureId: number): Promise<any[]> {
    try {
      const v = await this.withToken(async () => (await this.http.get(`/api/scores/snapshot/${fixtureId}`)).data);
      return Array.isArray(v) ? v : (Array.isArray(v?.events) ? v.events : (Array.isArray(v?.data) ? v.data : []));
    } catch { return []; }
  }

  /** A proof bundle for one (fixture, seq, stat).
   *
   * Only HITS are remembered. An anchored proof is immutable, so holding it forever is free and saves a
   * keeper sweeping twenty markets on one match from re-fetching the same bundles every tick. A miss is
   * never cached here: a seq that isn't anchored yet becomes anchored a few minutes later, and a stale
   * "no proof" would delay the payout — which is the one thing this product promises. */
  private proofs = new Map<string, any>();
  async statValidation(fixtureId: number, seq: number, statKey: number, statKey2?: number): Promise<any | null> {
    const key = `${fixtureId}:${seq}:${statKey}:${statKey2 ?? ""}`;
    const hit = this.proofs.get(key);
    if (hit) return hit;
    const v = await this.readStatValidation(fixtureId, seq, statKey, statKey2);
    if (v) this.proofs.set(key, v);
    return v;
  }

  private async readStatValidation(fixtureId: number, seq: number, statKey: number, statKey2?: number): Promise<any | null> {
    try {
      const v = await this.withToken(async () =>
        (await this.http.get("/api/scores/stat-validation", { params: { fixtureId, seq, statKey, ...(statKey2 ? { statKey2 } : {}) } })).data);
      return v?.ts ? v : null;
    } catch { return null; }
  }
}

let singleton: TxlineServer | null = null;
export function txline(): TxlineServer {
  if (!singleton) singleton = new TxlineServer();
  return singleton;
}
