# ThirdEye HTTP API + scanner reference

Companion to [`README.md`](../README.md). All paths assume `http://localhost:3001` unless noted.

## Auth

Every authenticated route requires `X-Auth-Token: <token>` from a session token. Mint one with:

```bash
curl -s -X POST http://localhost:3001/api/db/auth | jq -r .token
```

The token is a 256-bit random string with a 7-day TTL (`auth_tokens.expires_at`). Under `PUBLIC_INSTANCE_MODE=true`, `POST /api/db/auth` is itself rate-limited per IP (`AUTH_ISSUE_LIMIT_PER_HOUR`, default 10/hr).

The web dashboard, MCP server, and tg-bot all use this same token mechanism — the dashboard caches it in `sessionStorage`, the MCP/tg-bot processes use env vars directly.

## BYOK headers

| Header | Purpose | Behavior |
|---|---|---|
| `X-User-Helius-Key` | Override server's `HELIUS_API_KEY` for this request | Bypasses Helius proxy rate limits on `/api/helius/*` and `/api/helius-rpc`; bypasses scan-token rate limit on `/api/token/:mint/scan`. **Wallet check** still rate-limited regardless. |
| `X-User-Anthropic-Key` | Override server's `ANTHROPIC_API_KEY` for agent calls | Used by future browser-originated agent endpoints. Not consumed by current routes. |

Server code never branches on which key source is in use.

## Routes

### Health & auth

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness + db ping. Returns `{"ok":true,"db":"ok"}` or 503. |
| `POST` | `/api/db/auth` | Issue anonymous session token (7-day expiry). |

### Helius proxy (Phase 1)

LRU-cached pass-through. Every response carries `X-ThirdEye-Cache: HIT|MISS` and `X-ThirdEye-Proxy-Duration-Ms: <n>`.

| Method | Path | Cache | Notes |
|---|---|---|---|
| `GET` | `/api/helius/v1/wallet/:addr/identity` | 5min | Name, type, category. |
| `GET` | `/api/helius/v1/wallet/:addr/balances` | 5min | SOL + SPL token balances. |
| `GET` | `/api/helius/v1/wallet/:addr/funded-by` | **24h** | Funder address + timestamp. Immutable so long cache. |
| `GET` | `/api/helius/v0/addresses/:addr/transactions` | 5min | Parsed tx history. |
| `POST` | `/api/helius/v1/wallet/batch-identity` | 5min/elem | Body `{ addresses: [≤100] }`. |
| `POST` | `/api/helius/v0/transactions` | **24h**/sig | Body `{ transactions: [sigs ≤100] }`. |
| `POST` | `/api/helius-rpc` | per-method | JSON-RPC pass-through. Mutating methods (`sendTransaction`, `requestAirdrop`, etc.) are denied via allowlist. |

### Wallet (Phase 2)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/wallet/:addr/check` | **SSE** stream — full forensic pipeline. `?force=true` skips cache. |
| `GET` | `/api/wallet/:addr/last-check` | Latest cached `WalletCheckResult`, 404 if none. |

**SSE event sequence:** `started → identity → balances → funding → cluster → txPattern → tags → result`.

`result` payload: `score` (0–100), `scoreBucket` (CLEAN/LOW/MEDIUM/HIGH), `verdict` (EXCHANGE/SYBIL/BUNDLER/SNIPER BOT/WHALE/FRESH/SMART_MONEY/TRADER/CLEAN), `tags[]`, full funding chain, sibling cluster (with `cov`), `realizedPnlSol`, balances.

### Token (Phase 3)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/token/:mint/scan` | **SSE** stream — holder concentration, cluster grouping, risk score. `?force=true` skips cache. |
| `GET` | `/api/token/:mint/scans/latest` | Latest cached `TokenScanResult`, 404 if none. |

**SSE event sequence:** `started → metadata → holders → lpFilter → fundingProgress → clusters → result`.

`result` payload: per-cluster `members` + `totalPct`, `risk` (0–100), `sybilFlag`, `verdict` (CLEAN/LOW_RISK/HIGH_RISK), LP/lock breakdown.

### Intel (Phase 4 + 5c)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/db/intel/aggregates` | 24h pulse, all-time totals, risk distribution, heatmap data. |
| `GET` | `/api/db/intel/recent/scans` | Recent token scans across the network. |
| `GET` | `/api/db/intel/recent/checks` | Recent wallet checks across the network. |
| `POST` | `/api/db/intel/feed/ticket` | Issue a 30s single-use ticket. Auth via `X-Auth-Token` header. Use when the SSE client (e.g. browser EventSource) can't set custom headers. |
| `GET` | `/api/db/intel/feed?ticket=<single-use>` | **SSE** live intel-bus feed. |
| `GET` | `/api/db/intel/funders/top-clustered` | Top funders by `cluster_count` (cross-token bundler view). |
| `GET` | `/api/db/intel/funders/:addr/clusters` | Per-funder cluster history across all scanned tokens. |

**Intel-bus event kinds (today):** `hello`, `ping`, `scan:start`, `scan:complete`, `check:start`, `check:complete`, `tag:applied`, `watch:event`, `smartmoney:trade`, `smartmoney:confluence`, `smartmoney:signal`, `smartmoney:outcome`.

The `smartmoney:*` events ride the same feed: `trade` (a tracked wallet bought/sold), `confluence` (≥2 tracked wallets into one mint inside the window, with `coFunded` trust flag), `signal` (an independent confluence promoted to a tracked signal with a call-MC snapshot), and `outcome` (a worker tick updated an open signal's current/ATH multiple or closed it).

**Phase 6 will add:** `watch:anomaly`, `discovery:new_candidate`, `discovery:rescored`, `agent:run_started`, `agent:run_finished`.

### Watches (Phase 5e)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/db/watches` | Body `{ addresses: [string], label?: string }`. Adds + syncs to the managed Helius webhook. |
| `GET` | `/api/db/watches` | Current session's watches. |
| `DELETE` | `/api/db/watches/:address` | Unsubscribe + sync removal to Helius. |
| `GET` | `/api/db/watches/:address/events` | Recent events for an address (`?limit=50`). |
| `POST` | `/api/helius-webhook` | **Public ingest.** Helius calls this; auth-header validated against `HELIUS_WEBHOOK_AUTH`. |

### Tokens cache (Phase 6a)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/db/tokens/hot` | Filter the price cache. Query: `since=6h` (`Nm`/`Nh`/`Nd`), `minMcChange=5x` (or plain percent), `limit=20`. |
| `GET` | `/api/db/tokens/:mint` | Single mint lookup, 404 if not in cache. |

Backed by the `tokens` table. Every scan auto-seeds the mint, and the `tokens-refresh` worker hits DexScreener every 60s to keep price/MC/liquidity fresh. Source plumbed via the `PriceSource` interface in `@thirdeye/prices` (Birdeye/Jupiter documented as escape hatches in code comments).

---

## Tags emitted by the scanner

| Tag | Fires when |
|---|---|
| `EXCHANGE` | Wallet or its first-funder is a known CEX (see `packages/scanner/src/exchange-list.ts`). |
| `FRESH_WALLET` | Age < 14d AND tx count < 20. |
| `FUND_DISTRIBUTOR` | Has ≥10 unique outbound recipients. |
| `BUNDLER` | Cluster size ≥2 with non-exchange first-funder. |
| `BUNDLER_TIGHT` | `BUNDLER` plus ≥2 siblings funded inside the same 5-min time window. |
| `SYBIL` | `BUNDLER` plus cluster-CoV < 0.20 (siblings show similar SOL outflow patterns — coordinated). |
| `SNIPER` | Rapid-fire tx pattern, swap-only, avg gap < 30s. |
| `WHALE` | USD value > $50k AND token count ≤ 10. |
| `SMART_MONEY` | Realized SOL PnL across recent SWAPs ≥ `SMART_MONEY_MIN_SOL` (default 50). |
| `KOL` | Reserved for future external identity feed; not currently emitted. |

---

## Environment variables

Full reference in [`.env.example`](../.env.example). Quick guide to what matters:

### Required for any non-trivial use

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://thirdeye:thirdeye@localhost:5432/thirdeye` | Postgres connection. |
| `HELIUS_API_KEY` | unset | Required for `/api/helius/*` and `/api/helius-rpc`. [Get one free.](https://dashboard.helius.dev/api-keys) |
| `PORT` | `3001` | API listen port. |
| `CORS_ORIGIN` | `http://localhost:3000` | Browser origin allowed by CORS. Comma-separated for multiple. |

### Public-instance mode

Off by default. When you're hosting publicly, set `PUBLIC_INSTANCE_MODE=true` AND put a reverse proxy in front that sets `X-Forwarded-For` correctly and strips client-supplied `X-Forwarded-For` headers (per-IP rate limits are spoofable without this).

| Var | Default | Purpose |
|---|---|---|
| `PUBLIC_INSTANCE_MODE` | `false` | Enables anonymous-token rate limits + per-IP auth-issue limits. |
| `AUTH_ISSUE_LIMIT_PER_HOUR` | `10` | Per-IP cap on `POST /api/db/auth`. |
| `HELIUS_PROXY_LIMIT` / `HELIUS_PROXY_WINDOW_SEC` | `600` / `3600` | Per-token rate limit on Helius proxy. Bypassed with `X-User-Helius-Key`. |
| `WALLET_CHECK_LIMIT` / `WALLET_CHECK_WINDOW_SEC` / `WALLET_CHECK_CACHE_SEC` | `120` / `3600` / `14400` | Wallet check rate limit + cache TTL. |
| `SCAN_TOKEN_LIMIT` / `SCAN_TOKEN_WINDOW_SEC` / `SCAN_TOKEN_CACHE_SEC` | `60` / `3600` / `300` | Token scan rate limit + cache TTL. |

### Webhook ingest (Phase 5e)

Both unset by default — `/api/db/watches` returns 503 until you set them.

| Var | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Where Helius pushes events. Use ngrok locally (`https://abc123.ngrok-free.app`). |
| `HELIUS_WEBHOOK_AUTH` | Shared secret. Generate with `openssl rand -hex 32`. Set on the Helius webhook (we register on first /watches call) and validated on every inbound event. |

### Signal engine

| Var | Default | Purpose |
|---|---|---|
| `SIGNAL_HIT_MULTIPLIER` | `2` | A tracked signal counts as a "hit" once its ATH market cap reaches this multiple of the call-MC snapshot. The `signals-refresh` worker (graphile cron, every 60s) follows open signals' market cap via the free DexScreener source and closes them after 48h. |

### Agent (Phase 6b)

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Required for the agent paths (MCP, tg-bot, future discovery worker). |
| `AGENT_DAILY_COST_USD_CAP` | `25` | Per-day USD cost ceiling across all agent_runs. Enforced via Postgres advisory lock. |
| `AGENT_MAX_TOOL_CALLS_PER_RUN` | `20` | Per-run hard cap. |
| `AGENT_MAX_INPUT_TOKENS_PER_RUN` | `200000` | Per-run cumulative input token cap. |
| `AGENT_CHEAP_MODEL` | `claude-haiku-4-5-20251001` | Override for cheap loops. |
| `AGENT_REASONING_MODEL` | `claude-sonnet-4-6` | Override for cluster expander / morning brief. |

### Telegram bot (Phase 6b.6)

Both must be set or the bot self-disables. The api still serves normally.

| Var | Purpose |
|---|---|
| `TG_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather). Format `<bot_id>:<hash>`. |
| `TG_ALLOWED_CHAT_ID` | Your numeric chat ID from [@userinfobot](https://t.me/userinfobot). The bot silently ignores every other chat. |

### MCP server (Phase 6b.5)

| Var | Default | Purpose |
|---|---|---|
| `MCP_MAX_TOOL_CALLS_PER_SESSION` | `200` | Per-process cap on tool dispatches. Counter resets on bin.ts restart. |

### Web dashboard (Phase 6f-min)

Consumed by `apps/web` at build/dev time.

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3001` | Where Next dev rewrites proxy `/api/*` to. Override for staging deploys (and update `CORS_ORIGIN` on the api side correspondingly). |

---

## Response headers

Every `/api/helius/*` and `/api/helius-rpc` response carries:

| Header | Meaning |
|---|---|
| `X-ThirdEye-Cache: HIT \| MISS` | Whether the response came from the local LRU cache. |
| `X-ThirdEye-Proxy-Duration-Ms: <n>` | End-to-end ms inside the proxy handler. |

Use these for client-side observability and to confirm BYOK is in play (a BYOK request misses the cache the first time and the same key gets cache HITs after).
