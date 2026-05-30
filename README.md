# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics — with smart-money alpha tracking on top. Paste a wallet address, get its funding chain, sibling cluster, behavioral tags, realized PnL, risk score. Paste a token mint, get its holder concentration grouped by first funder — bundles and sybil rings light up immediately. Curate a set of smart-money wallets and ThirdEye streams their trades, flags confluence (≥2 *independent* wallets into the same token), and scores each signal by the market-cap multiple it goes on to hit. Self-hostable, MIT licensed.

Use it from a [browser dashboard](#1-browser-dashboard-recommended) or [the raw HTTP API](#2-raw-http-api).

---

## Quickstart

You need [Bun](https://bun.sh) ≥ 1.2, Docker + Docker Compose, and a free [Helius API key](https://dashboard.helius.dev/api-keys).

### Option A — just want to use it

Everything in containers. One terminal for the api stack, one for the web dashboard.

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
# edit .env: set HELIUS_API_KEY=...
bun install                       # workspace deps (needed for the migrate script)

# Bring up the api + Postgres together:
docker compose up -d --build
bun run migrate                   # apply schema (one time)
curl http://localhost:3001/health # → {"ok":true,"db":"ok"}

# In a second terminal, launch the web dashboard:
cd apps/web && bun run dev        # → http://localhost:3000
```

Open `http://localhost:3000`, paste a wallet address or token mint, hit **investigate**.

### Option B — want to hack on the api

Only Postgres runs in a container; api + web run locally with hot reload.

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env              # set HELIUS_API_KEY
bun install

docker compose up -d postgres     # just the database
bun run migrate

bun run dev                       # terminal 1: api on :3001 (hot reload)
cd apps/web && bun run dev        # terminal 2: web on :3000
```

> **Don't mix the two.** If you `docker compose up -d --build` AND `bun run dev`, you'll bind port 3001 twice and one will fail.

---

## Try it

A few real Solana addresses to paste into the dashboard or curl against directly:

| What | Address |
|---|---|
| **USDC mint** (clean, exchange-held) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| **Wrapped SOL mint** (clean) | `So11111111111111111111111111111111111111112` |
| **Binance hot wallet** | `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9` |

For a token launch, drop the mint into the dashboard or:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/db/auth | jq -r .token)

# SSE stream — watch the events arrive
curl -N http://localhost:3001/api/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/scan \
  -H "X-Auth-Token: $TOKEN"
```

---

## Where to use it from

### 1. Browser dashboard (recommended)

`apps/web` — Next.js + Tailwind dashboard with six pages: landing (paste a wallet or mint), `/wallet/[addr]` and `/token/[mint]` with SSE-streamed scan results, `/intel` live event feed (with a smart-money tab: tracked-wallet trades + confluence + watchlist), `/leaderboard` outcome-scored top traders, `/settings` Helius BYOK key. Forensics-terminal aesthetic — IBM Plex Mono/Sans, deep-navy + amber palette, the full base58 address rendered as the visual anchor of every detail page. See [`apps/web/README.md`](apps/web/README.md).

### 2. Raw HTTP API

The dashboard is a thin client on top of the same HTTP API. Full surface in [`docs/REFERENCE.md`](docs/REFERENCE.md) — health, auth, Helius RPC proxy, wallet check, token scan, intel feed, watches, tokens cache.

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/db/auth | jq -r .token)

# Check a wallet (SSE)
curl -N http://localhost:3001/api/wallet/<addr>/check \
  -H "X-Auth-Token: $TOKEN"

# Subscribe a wallet for real-time alerts
curl -X POST http://localhost:3001/api/db/watches \
  -H "Content-Type: application/json" -H "X-Auth-Token: $TOKEN" \
  -d '{"addresses":["<wallet>"],"label":"watching for dump"}'
```

---

## What it does

Four forensic tools sharing one intelligence database:

| Tool | Question it answers |
|---|---|
| **Check Wallet** | Who funded this wallet? What's its sibling cohort? Has it been swapping like a sniper bot? Is it on net realizing SOL profits? Should I worry about it? |
| **Scan Token** | Are the top holders all related? What % of supply is in clusters that share a first funder? Where's the LP and is it locked? |
| **Intel Analytics** | What's the network-wide pulse — recent scans, top-clustered funders across tokens, risk distribution? |
| **Watches** | Subscribe to an address via Helius webhook; events stream into the intel-bus and the per-watch event log in real time. |

### How cluster detection works

Every wallet has a *first funder* — the wallet that first sent it SOL. Group token holders by their first funder, and you find the bundles, the sybil rings, the insider clusters. ThirdEye computes this for any token in seconds, with a coefficient-of-variation pass over the cluster's tx amounts to separate organic clusters from coordinated ones.

Tags emitted by the scanner — full table in [`docs/REFERENCE.md`](docs/REFERENCE.md):

`EXCHANGE` · `FRESH_WALLET` · `FUND_DISTRIBUTOR` · `BUNDLER` · `BUNDLER_TIGHT` · `SYBIL` · `SNIPER` · `WHALE` · `SMART_MONEY` · `KOL`

---

## Stack

Bun · Hono · Drizzle · Postgres 16 · `graphile-worker` (cron + watch-sync + signal outcomes) · Next 15 + Tailwind 3.4 + React 19 (web dashboard) · Helius RPC (REST + JSON-RPC + Webhooks) · DexScreener (price/market-cap).

Two services, one Postgres. No Redis, no message broker, no separate cache server. Self-host with `docker compose up`.

BYOK transparent: set `X-User-Helius-Key` to bypass the server's Helius key and rate limits. The server never branches on which key is in use.

`PUBLIC_INSTANCE_MODE=true` enables anonymous-token rate limiting (for hosted deployments); default `false` runs unmetered (for self-host).

---

## Status

| Phase | What |
|---|---|
| 0 – 5e | v1 backend — auth, Helius proxy, Check Wallet, Scan Token, Intel analytics, alpha-extraction hardening (SMART_MONEY, cluster CoV, cross-token bundler view), webhook watches |
| 6.0 | Intel-bus on Postgres LISTEN/NOTIFY (cross-process events) |
| 6a | Tokens cache + DexScreener + hot-tokens API |
| 6f-min | `apps/web` — six-page web dashboard |
| 6f | Smart-money feed — curated tracked wallets, live trade stream, confluence detection with a co-funded trust filter (`/intel` smart-money tab) |
| signal engine | Signal-outcome tracking — independent confluence promoted to a tracked signal, market cap followed to its ATH multiple + hit/miss with a conservative "safe" replay, outcome-scored wallet attribution (backend: `signals` table + `signals-refresh` worker) |

**Next:** wallet-universe acquisition (leaderboard-seeded candidate set) and the alpha dashboard UI (live signal cards, trending, outcome-scored leaderboard). See the [alpha-tracker delta spec](docs/superpowers/specs/2026-05-28-thirdeye-alpha-tracker-delta.md).

**Deferred (v2+):** Telegram/Twitter signal ingest, LaserStream gRPC migration, behavior embeddings, CLI surface, multi-provider Helius abstraction.

---

## Operations

Brief notes on rollback, monitoring, and the pre-deploy checklist live in [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Health endpoint: `GET /health` returns `{"ok":true,"db":"ok"}` when the api can reach Postgres — wire this to your platform's uptime monitor.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). TL;DR: `bun install && docker compose up -d postgres && bun run migrate && bun test`. Lint, typecheck, and tests must be green.

Canonical design spec: [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md). Per-phase specs sit alongside it.

## License

MIT
