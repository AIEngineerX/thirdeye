# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics. Paste a wallet address, get its funding chain, sibling cluster, behavioral tags, realized PnL, risk score. Paste a token mint, get its holder concentration grouped by first funder — bundles and sybil rings light up immediately. Self-hostable, MIT licensed.

Use it from a [browser dashboard](#1-browser-dashboard-recommended), from [Claude Desktop via MCP](#2-claude-desktop-mcp), from [a Telegram bot](#3-telegram-bot), or [from the raw HTTP API](#4-raw-http-api).

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

`apps/web` — Next.js + Tailwind dashboard with five pages: landing (paste a wallet or mint), `/wallet/[addr]` and `/token/[mint]` with SSE-streamed scan results, `/intel` live event feed, `/settings` BYOK keys. Forensics-terminal aesthetic — IBM Plex Mono/Sans, deep-navy + amber palette, the full base58 address rendered as the visual anchor of every detail page. See [`apps/web/README.md`](apps/web/README.md).

### 2. Claude Desktop (MCP)

`@thirdeye/mcp-server` exposes the six forensics tools (`checkWallet`, `scanToken`, `getClusterSiblings`, `getFunderClusters`, `getHotTokens`, `getWatchlist`) to any MCP client. Point Claude Desktop's `claude_desktop_config.json` at `packages/mcp-server/src/bin.ts` and ask in natural language. See [`packages/mcp-server/README.md`](packages/mcp-server/README.md).

### 3. Telegram bot

`@thirdeye/tg-bot` — single-user Telegram bot embedded in the api process. Set `TG_BOT_TOKEN` + `TG_ALLOWED_CHAT_ID`, restart, chat with your bot. Same six tools via natural language. See [`packages/tg-bot/README.md`](packages/tg-bot/README.md).

### 4. Raw HTTP API

The dashboard, MCP server, and tg-bot are all thin clients on top of the same HTTP API. Full surface in [`docs/REFERENCE.md`](docs/REFERENCE.md) — health, auth, Helius proxy, wallet check, token scan, intel aggregates + feed, watches, tokens cache.

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

Bun · Hono · Drizzle · Postgres 16 · `graphile-worker` (cron + watch-sync) · Next 15 + Tailwind 3.4 + React 19 (web dashboard) · Anthropic SDK (agent loops, MCP, tg-bot) · Helius RPC (REST + JSON-RPC + Webhooks).

Two services, one Postgres. No Redis, no message broker, no separate cache server. Self-host with `docker compose up`.

BYOK transparent: set `X-User-Helius-Key` / `X-User-Anthropic-Key` to bypass server keys and rate limits. The server never branches on which key is in use.

`PUBLIC_INSTANCE_MODE=true` enables anonymous-token rate limiting (for hosted deployments); default `false` runs unmetered (for self-host).

---

## Status

| Phase | What |
|---|---|
| 0 – 5e | v1 backend — auth, Helius proxy, Check Wallet, Scan Token, Intel analytics, alpha-extraction hardening (SMART_MONEY, cluster CoV, cross-token bundler view), webhook watches |
| 6.0 | Intel-bus on Postgres LISTEN/NOTIFY (cross-process events) |
| 6a | Tokens cache + DexScreener + hot-tokens API |
| 6b | `@thirdeye/agent` — Anthropic SDK tool-use loop, prompt caching, advisory-lock budget gate, `agent_runs` audit table |
| 6b.5 | `@thirdeye/mcp-server` — MCP transport |
| 6b.6 | `@thirdeye/tg-bot` — Telegram bot |
| 6f-min | `apps/web` — five-page web dashboard |

**In progress (Phase 6 remainder):** Discovery loop (`6c`), anomaly detector (`6d`), morning brief (`6e`), full dashboard widgets (`6g`), cluster expander (`6j`), polish (`6k`). See [`docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md`](docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md).

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
