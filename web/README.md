# GAFFER — web

The GAFFER player experience: a Next.js 16 (App Router) PWA. Product overview and architecture live in the [repo root README](../README.md); this covers running and extending the web app.

## Setup

```bash
cp .env.example .env.local   # then fill the required values below
npm install
npm run dev                  # http://localhost:3000
```

## Environment

| Var | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres (Neon) — squads + the server-authoritative points ledger |
| `GAFFER_KEYPAIR_SECRET` | serverless | Market-authority / keeper / faucet key as a JSON byte array (serverless can't read the key file) |
| `NEXT_PUBLIC_SOLANA_RPC` | recommended | A dedicated RPC; public devnet rate-limits under load |
| `NEXT_PUBLIC_PRIVY_APP_ID` / `PRIVY_APP_SECRET` | optional | Enables Privy embedded wallets; unset → each browser gets a local dev wallet |
| `GAFFER_ADMIN_KEY` | prod | Guards keeper/admin routes (they fail **closed** without it) |
| `ALLOW_OPEN_ADMIN` | dev only | Runs admin routes with no key — must be unset in production |
| `NEXT_PUBLIC_GAFFER_DEV` | dev only | `1` shows demo controls (spin-up pool, manual settle); off for consumers |
| `FAUCET_ENABLED` / `FAUCET_IP_MAX_PER_HOUR` | devnet | Dev faucet toggle + per-IP cap |

## Layout

```
src/
  app/api/        route handlers — markets · scores · squad · points · nations · streak-grid ·
                  create-market · settle · fund (faucet)
  components/     GafferApp.tsx — the whole player UI (Today/Live/Slip/Squad/Nations/Cash/You)
  lib/            db (Neon)            · points (server-authoritative ledger, on-chain-verified grants)
                  squadStore           · kernel/kernelClient/parlayClient (on-chain reads + browser writes)
                  txline (server data) · errcopy (felt error map) · serverConfig · config
```

## Conventions

- **Felt-not-shown.** No crypto/finance jargon in user-facing copy (`errcopy.ts` maps every failure to plain language). The money layer should read like cash, not a chain.
- **Server-authoritative points.** The client never posts a total; grants are token-guarded and money grants are verified down to the exact on-chain instruction.
- **Typed data boundaries.** Market/parlay/squad data flows through `MarketView` / `ParlayView` / `PubSquad`; the component-props layer is intentionally loose for velocity.

## Scripts

`npm run dev` · `npm run build` · `npm run start` · `npm run lint`
