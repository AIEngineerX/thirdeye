# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics — bundle/sybil detection, funding-chain tracing, cluster analysis. Self-hostable in two containers, free public instance forthcoming.

## What it does

Three forensic tools sharing one intelligence database:

1. **Check Wallet** — paste a wallet, see its funding chain, behavioral tags, and clustered relatives.
2. **Scan Token** — paste a mint, get holder distribution clustered by first funder. Surfaces bundles, sybils, LP/lock breakdown.
3. **Intel Analytics** — network-wide rollup: 24h pulse, all-time totals, risk distribution, live activity feed, heatmap.

## How the cluster detection works

Every wallet has a *first funder* — the wallet that first sent it SOL. Group token holders by their first funder, and you find the bundles, the sybil rings, the insider clusters. ThirdEye does this for any token in seconds, with results cached and shared across the network.

## Status

| Phase | Scope | Status |
|---|---|---|
| **0** | Bun monorepo, Postgres, Drizzle, anonymous-token auth, Docker compose, GitHub Actions CI | ✅ shipped |
| **1** | Helius proxy (`/api/helius/*` + `/api/helius-rpc`), 2-tier LRU cache, sliding-window rate limit on `auth_tokens.rate_bucket`, BYOK via `X-User-Helius-Key` | ✅ shipped |
| **2** | Check Wallet — SSE-streamed pipeline (identity → balances → multi-hop funding chain → cluster + time-window + CoV → tx pattern → tags → score + verdict). `@thirdeye/scanner` package, exchange seed list, decoupled score & verdict. | ✅ shipped |
| **3** | Scan Token pipeline (top holders → LP/lock filter → batched funded-by → cluster grouping → risk score → save) | next |
| **4** | Intel Analytics + SSE feed at `/api/db/intel/feed` | planned |
| **5–8** | Next.js 16 frontend (shell, wallet, token, intel pages) | planned |

Per-phase plans live under [`docs/superpowers/plans/`](docs/superpowers/plans). The canonical design spec is [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md).

## Quick start (self-host)

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
# edit .env: set HELIUS_API_KEY (free tier at https://dashboard.helius.dev/api-keys)

# Run the full stack (app + postgres):
docker compose up -d --build
bun run migrate         # apply schema once
curl http://localhost:3001/health    # → {"ok":true}
```

Issue an anonymous session token then probe a route:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/db/auth \
  -H "Content-Type: application/json" -d '{}' | jq -r .token)

curl http://localhost:3001/api/helius/v1/wallet/<some-wallet>/funded-by \
  -H "X-Auth-Token: $TOKEN"
```

## Stack

Bun · Hono · Drizzle · Postgres 16 · `graphile-worker` (Phase 2+) · Next.js 16 (Phase 5+) · Helius RPC

Two services, one Postgres. No Redis, no message broker, no separate cache server. Self-host with `docker compose up`. Use the public instance for free with rate limits, or set `X-User-Helius-Key` to bypass them with your own Helius key.

## API surface (today)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | liveness |
| `POST` | `/api/db/auth` | issue anonymous session token (7-day expiry) |
| `GET` | `/api/helius/v1/wallet/:addr/identity` | 5min cache |
| `GET` | `/api/helius/v1/wallet/:addr/balances` | 5min cache |
| `GET` | `/api/helius/v1/wallet/:addr/funded-by` | **24h** cache (immutable) |
| `GET` | `/api/helius/v0/addresses/:addr/transactions` | 5min cache |
| `POST` | `/api/helius/v1/wallet/batch-identity` | body `{ addresses: [≤100] }` |
| `POST` | `/api/helius/v0/transactions` | body `{ transactions: [sigs ≤100] }`, **24h** cache |
| `POST` | `/api/helius-rpc` | JSON-RPC pass-through; mutating methods denied (`sendTransaction` etc.) |
| `GET` | `/api/wallet/:addr/check` | **SSE** stream — full forensic pipeline. `?force=true` skips 24h cache. |
| `GET` | `/api/wallet/:addr/last-check` | latest cached `WalletCheckResult` (JSON), 404 if none |

Every `/api/helius/*` and `/api/helius-rpc` response carries `X-ThirdEye-Cache: HIT|MISS` and `X-ThirdEye-Proxy-Duration-Ms: <n>` for client-side observability.

`/api/wallet/:addr/check` event sequence: `started → identity → balances → funding → cluster → txPattern → tags → result`. The `result` payload includes `score` (0–100), `scoreBucket` (CLEAN/LOW/MEDIUM/HIGH), `verdict` (EXCHANGE/SYBIL/BUNDLER/SNIPER BOT/WHALE/FRESH/TRADER/CLEAN), tags, full funding chain, sibling cluster, and balances.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). TL;DR: `bun install && docker compose up -d postgres && bun run migrate && bun test`. Linter, typechecker, and full test suite must be green before opening a PR.

## License

MIT
