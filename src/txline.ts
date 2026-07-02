/** TxLINE client — auth/subscribe/activate, proof bundles, historical + live SSE. */
import axios, { AxiosInstance } from "axios";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

export const API = process.env.TXLINE_API || "https://txline-dev.txodds.com";
export const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
export const SUB_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

export class TxlineClient {
  jwt = "";
  apiToken = "";
  http: AxiosInstance;
  constructor(private conn: Connection, private payer: Keypair) {
    this.http = axios.create({ baseURL: API, timeout: 30000, headers: { "Content-Type": "application/json" } });
  }

  /** Guest JWT -> on-chain subscribe (free SL1, 4 weeks) -> activate -> apiToken. */
  async authenticate(): Promise<this> {
    this.jwt = (await this.http.post("/auth/guest/start")).data.token;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.jwt}`;

    const provider = new AnchorProvider(this.conn, new Wallet(this.payer), { commitment: "confirmed" });
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "idl", "txoracle.json"), "utf8"));
    const prog: any = new Program(idl, provider);
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
    const ar = (await axios.post(`${API}/api/token/activate`, { txSig: subSig, walletSignature, leagues: [] }, { headers: { Authorization: `Bearer ${this.jwt}` } })).data;
    this.apiToken = ar.token || ar;
    this.http.defaults.headers.common["X-Api-Token"] = this.apiToken;
    return this;
  }

  /** Merkle proof bundle for a (fixture, seq, statKey), or null if not anchored/available. */
  async statValidation(fixtureId: number, seq: number, statKey: number, statKey2?: number): Promise<any | null> {
    try {
      const v = (await this.http.get("/api/scores/stat-validation", { params: { fixtureId, seq, statKey, ...(statKey2 ? { statKey2 } : {}) } })).data;
      return v?.ts ? v : null;
    } catch { return null; }
  }

  /** Parsed events from the historical (re-run) SSE text stream for a fixture. */
  async historicalEvents(fixtureId: number): Promise<any[]> {
    const raw: string = (await this.http.get(`/api/scores/historical/${fixtureId}`, { transformResponse: (r) => r })).data;
    return (typeof raw === "string" ? raw : "")
      .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:"))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
      .filter(Boolean) as any[];
  }

  /** Live scores SSE — calls onEvent per parsed `data:` line. Used by the GAFFER UI feed. */
  async streamScores(onEvent: (e: any) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${API}/api/scores/stream`, {
      headers: { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken, Accept: "text/event-stream" },
      signal,
    });
    const reader = (res.body as any).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) { try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore keep-alive */ } }
      }
    }
  }
}
