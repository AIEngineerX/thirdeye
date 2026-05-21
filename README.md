# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics — bundle/sybil detection, funding-chain tracing, cluster analysis, SMART_MONEY ranking, real-time wallet alerts. Self-hostable in two containers, free public instance forthcoming.

## What it does

Three forensic tools sharing one intelligence database, plus an alpha-extraction layer:

1. **Check Wallet** — paste a wallet, see its funding chain, behavioral tags, sibling cluster, realized SOL PnL, and SMART_MONEY ranking.
2. **Scan Token** — paste a mint, get holder distribution clustered by first funder. Surfaces bundles, sybils, LP/lock breakdown, cross-token funder reuse.
3. **Intel Analytics** — network-wide rollup: 24h pulse, all-time totals, risk distribution, top-clustered funders, live SSE activity feed.
4. **Watches** *(Phase 5e)* — subscribe to any address via Helius webhook; events stream into the intel-bus and the per-watch event log in real time.

## How the cluster detection works

Every wallet has a *first funder* — the wallet that first sent it SOL. Group token holders by their first funder, and you find the bundles, the sybil rings, the insider clusters. ThirdEye does this for any token in seconds, with results cached and shared across the network. Phase 5b lit up cluster CoV (coefficient of variation across sibling SOL outflows), making the SYBIL tag a real signal instead of always-null.

## Status

| Phase | Scope | Status |
|---|---|---|
| **0** | Bun monorepo, Postgres, Drizzle, anonymous-token auth, Docker compose, GitHub Actions CI | shipped |
| **1** | Helius proxy (`/api/helius/*` + `/api/helius-rpc`), 2-tier LRU cache, sliding-window rate limit on `auth_tokens.rate_bucket`, BYOK via `X-User-Helius-Key` | shipped |
| **2** | Check Wallet — SSE-streamed pipeline (identity → balances → multi-hop funding chain → cluster + time-window + CoV → tx pattern → tags → score + verdict). `@thirdeye/scanner` package, exchange seed list, decoupled score & verdict | shipped |
| **3** | Scan Token — SSE pipeline (top holders → LP/lock filter → batched funded-by → cluster grouping → risk score → persist). `funders.cluster_count` denormalized for cross-token reuse | shipped |
| **4** | Intel Analytics — aggregates table, refresh-aggregates worker, recent-scans/checks endpoints, SSE feed at `/api/db/intel/feed`, graphile-worker cron | shipped |
| **5a** | Tag thresholds + cache TTLs tuned for current Solana memecoin tempo | shipped |
| **5b** | Cluster CoV computation — lights up SYBIL tag (was always null in Phase 2) | shipped |
| **5c** | Cross-token bundler view — `/api/db/intel/funders/top-clustered` and `/funders/:addr/clusters` | shipped |
| **5d** | `SMART_MONEY` tag — realized SOL PnL across recent SWAPs, threshold-gated, `wallets.realized_pnl_sol` | shipped |
| **5e** | Helius webhook subscription — `watches` CRUD, `watch_events`, single managed Helius webhook synced from local watch set | shipped |
| **6.0** | intel-bus migration — Postgres `LISTEN/NOTIFY` with overflow table for >7800-byte payloads (cross-process worker → API events) | shipped |
| **6a** | Tokens cache + `@thirdeye/prices` package + DexScreener `PriceSource` + `tokens-refresh` worker (60s cron) + `/api/db/tokens/hot` and `/:mint` | shipped |
| **6b** | `@thirdeye/agent` package — Anthropic SDK + tool-use loop + prompt caching + per-run/daily cost caps (advisory-lock budget gate) + `agent_runs` audit table + replay test harness | shipped |
| **6b.5** | `@thirdeye/mcp-server` — Model Context Protocol stdio transport over the agent tool registry; the six forensics tools become callable from Claude Desktop / Cursor / any MCP client | shipped |
| **6b.6** | `@thirdeye/tg-bot` — Single-user Telegram bot embedded in the api process; six forensics tools accessible via natural-language chat, deployed to Railway alongside the api | shipped |
| **6f-min** | `apps/web` — Next 15 dashboard MVP. Forensics-terminal aesthetic (IBM Plex Mono/Sans, OKLCH palette, sharp edges, address banner). Five pages: landing (single input + wallet/token toggle), `/wallet/[addr]` and `/token/[mint]` SSE-streamed scan results, `/intel` live event feed with ticket flow, `/settings` BYOK key entry with test-connection probe | shipped |
| **6** | Personal alpha terminal — agent brain (discovery, anomaly, cluster expander), full dashboard widgets, polish — sub-phases 6c-e and 6g-k remain | in progress — see [phase 6 spec](docs/superpowers/specs/2026-05-07-thirdeye-phase-6-design.md) |
| 7+ | TG ingest, LaserStream migration, behavior embeddings, CLI surface, multi-provider Helius abstraction | deferred |

The canonical design spec is [`docs/superpowers/specs/2026-05-01-thirdeye-design.md`](docs/superpowers/specs/2026-05-01-thirdeye-design.md). Per-phase specs live alongside it (e.g. Phase 5 alpha-extraction at [`docs/superpowers/specs/2026-05-06-thirdeye-phase-5-alpha-design.md`](docs/superpowers/specs/2026-05-06-thirdeye-phase-5-alpha-design.md)).

## Quick start (self-host)

```bash
git clone https://github.com/AIEngineerX/thirdeye
cd thirdeye
cp .env.example .env
# edit .env: set HELIUS_API_KEY (free tier at https://dashboard.helius.dev/api-keys)

# Run the full stack (app + postgres):
docker compose up -d --build
bun run migrate         # apply schema once
curl http://localhost:3001/health    # → {"ok":true,"db":"ok"}

# Launch the web dashboard (separate terminal, separate port):
cd apps/web
bun install            # first time only
bun run dev            # http://localhost:3000
```

Issue an anonymous session token then probe a route:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/db/auth \
  -H "Content-Type: application/json" -d '{}' | jq -r .token)

curl http://localhost:3001/api/helius/v1/wallet/<some-wallet>/funded-by \
  -H "X-Auth-Token: $TOKEN"

# Scan a token (SSE stream):
curl -N http://localhost:3001/api/token/<mint>/scan \
  -H "X-Auth-Token: $TOKEN"

# Subscribe a wallet for real-time alerts:
curl -X POST http://localhost:3001/api/db/watches \
  -H "Content-Type: application/json" -H "X-Auth-Token: $TOKEN" \
  -d '{"addresses":["<wallet>"],"label":"watching for dump"}'

# Live SSE intel feed:
# SSE auth: obtain a single-use ticket (token never lands in URLs/logs),
# then connect:
TICKET=$(curl -s -X POST http://localhost:3001/api/db/intel/feed/ticket \
  -H "X-Auth-Token: $TOKEN" | jq -r .ticket)
curl -N "http://localhost:3001/api/db/intel/feed?ticket=$TICKET"
```

## Use from the web dashboard

Phase 6f-minimal ships [`apps/web`](apps/web) — a Next.js client-side dashboard with five pages: landing (paste a wallet or mint), `/wallet/[addr]` and `/token/[mint]` with SSE-streamed scan results, `/intel` live event feed, `/settings` for BYOK key entry. Forensics-terminal aesthetic — IBM Plex Mono/Sans, deep-navy + amber palette, the full 32-44 char address rendered as the visual anchor of every detail page.

```bash
# Two terminals — api on :3001, web on :3000.
bun run dev                            # terminal 1 (api)
cd apps/web && bun run dev             # terminal 2 (web)
# → http://localhost:3000
```

Next dev rewrites `/api/*` to the api so the browser sees same-origin requests (no CORS preflight in dev). Set `NEXT_PUBLIC_API_BASE_URL` if your api lives elsewhere.

## Use from Claude Desktop (MCP)

Phase 6b.5 ships [`@thirdeye/mcp-server`](packages/mcp-server/README.md) — a Model Context Protocol server that exposes the six forensics tools above (`checkWallet`, `scanToken`, `getClusterSiblings`, `getFunderClusters`, `getHotTokens`, `getWatchlist`) to any MCP client. Point Claude Desktop's `claude_desktop_config.json` at `packages/mcp-server/src/bin.ts` and the tools light up natively. See [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the working config snippet.

## Use from Telegram

Phase 6b.6 ships [`@thirdeye/tg-bot`](packages/tg-bot/README.md) — a single-user Telegram bot embedded in the api process. Set `TG_BOT_TOKEN` (from @BotFather) and `TG_ALLOWED_CHAT_ID` (your numeric chat ID from @userinfobot), redeploy, and chat with the bot in Telegram. The same six forensics tools the MCP server exposes are accessible via natural language. See [`packages/tg-bot/README.md`](packages/tg-bot/README.md) for setup.

## Stack

Bun · Hono · Drizzle · Postgres 16 · `graphile-worker` (cron + watch-sync) · Next.js 15 + Tailwind 3.4 + React 19 (web dashboard) · Helius RPC (REST + JSON-RPC + Webhooks)

Two services, one Postgres. No Redis, no message broker, no separate cache server. Self-host with `docker compose up`. Use the public instance for free with rate limits, or set `X-User-Helius-Key` to bypass them with your own Helius key.

## Tags emitted by the scanner

| Tag | Fires when |
|---|---|
| `EXCHANGE` | Wallet or its first-funder is a known CEX |
| `FRESH_WALLET` | Age < 14d AND tx count < 20 |
| `FUND_DISTRIBUTOR` | Has ≥10 unique outbound recipients |
| `BUNDLER` | Cluster size ≥2 with non-exchange first-funder |
| `BUNDLER_TIGHT` | BUNDLER plus ≥2 siblings funded inside the same time window |
| `SYBIL` | BUNDLER plus cluster-CoV < 0.20 (similar SOL outflow patterns) |
| `SNIPER` | Rapid-fire tx pattern, swap-only, avg gap < 30s |
| `WHALE` | USD value > $50k AND token count ≤ 10 |
| `SMART_MONEY` | Realized SOL PnL across recent SWAPs ≥ `SMART_MONEY_MIN_SOL` (default 50) |

## API surface (today)

### Health & auth

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | liveness + db ping |
| `POST` | `/api/db/auth` | issue anonymous session token (7-day expiry) |

### Helius proxy

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/helius/v1/wallet/:addr/identity` | 5min cache |
| `GET` | `/api/helius/v1/wallet/:addr/balances` | 5min cache |
| `GET` | `/api/helius/v1/wallet/:addr/funded-by` | **24h** cache (immutable) |
| `GET` | `/api/helius/v0/addresses/:addr/transactions` | 5min cache |
| `POST` | `/api/helius/v1/wallet/batch-identity` | body `{ addresses: [≤100] }` |
| `POST` | `/api/helius/v0/transactions` | body `{ transactions: [sigs ≤100] }`, **24h** cache |
| `POST` | `/api/helius-rpc` | JSON-RPC pass-through; mutating methods denied (`sendTransaction` etc.) |

### Wallet (Phase 2)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/wallet/:addr/check` | **SSE** stream — full forensic pipeline. `?force=true` skips cache |
| `GET` | `/api/wallet/:addr/last-check` | latest cached `WalletCheckResult`, 404 if none |

### Token (Phase 3)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/token/:mint/scan` | **SSE** stream — holder concentration, cluster grouping, risk score |
| `GET` | `/api/token/:mint/scans/latest` | latest cached scan result, 404 if none |

### Intel (Phase 4 + 5c)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/db/intel/aggregates` | 24h pulse, all-time totals, risk distribution, heatmap |
| `GET` | `/api/db/intel/recent/scans` | recent token scans across the network |
| `GET` | `/api/db/intel/recent/checks` | recent wallet checks across the network |
| `POST` | `/api/db/intel/feed/ticket` | obtain a 30s single-use ticket; auth via `X-Auth-Token` header. Use when the SSE client (e.g. browser EventSource) can't set custom headers. |
| `GET` | `/api/db/intel/feed` | **SSE** live intel-bus feed (auth via `?ticket=<single-use>` from `/feed/ticket`) |
| `GET` | `/api/db/intel/funders/top-clustered` | top funders by `cluster_count` (cross-token bundler view) |
| `GET` | `/api/db/intel/funders/:addr/clusters` | per-funder cluster history across all scanned tokens |

### Watches (Phase 5e)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/db/watches` | body `{ addresses: [string], label?: string }` — adds + syncs to managed Helius webhook |
| `GET` | `/api/db/watches` | current session's watches |
| `DELETE` | `/api/db/watches/:address` | unsubscribe + sync removal to Helius |
| `GET` | `/api/db/watches/:address/events` | recent events for an address (`?limit=50`) |
| `POST` | `/api/helius-webhook` | **public** ingest — Helius calls this; auth-header validated against `HELIUS_WEBHOOK_AUTH` |

### Tokens (Phase 6a)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/db/tokens/hot` | filter the price cache; query: `since=6h` (`Nm`/`Nh`/`Nd`), `minMcChange=5x` (or plain percent), `limit=20` |
| `GET` | `/api/db/tokens/:mint` | single mint lookup, 404 if not in cache |

Backed by the `tokens` table — every scan auto-seeds the row, and the `tokens-refresh` worker hits DexScreener every 60s to keep price/MC/liquidity fresh. Source plumbed via the `PriceSource` interface in `@thirdeye/prices` (Birdeye/Jupiter as documented escape hatches).

Every `/api/helius/*` and `/api/helius-rpc` response carries `X-ThirdEye-Cache: HIT|MISS` and `X-ThirdEye-Proxy-Duration-Ms: <n>` for client-side observability.

`/api/wallet/:addr/check` event sequence: `started → identity → balances → funding → cluster → txPattern → tags → result`. The `result` payload includes `score` (0–100), `scoreBucket` (CLEAN/LOW/MEDIUM/HIGH), `verdict` (EXCHANGE/SYBIL/BUNDLER/SNIPER BOT/WHALE/FRESH/SMART_MONEY/TRADER/CLEAN), tags, full funding chain, sibling cluster (with CoV), `realizedPnlSol`, balances.

`/api/token/:mint/scan` event sequence: `started → metadata → holders → fundedBy → clusters → result`. The `result` payload includes per-cluster member counts, risk percentage, sybil flag, LP/lock breakdown.

`/api/db/intel/feed` event kinds emitted today: `token:scan`, `wallet:check`, `watch:event`. Phase 6 adds `watch:anomaly`, `discovery:new_candidate`, `discovery:rescored`, `agent:run_started`, `agent:run_finished`.

## Operations

### Rollback

The codebase commits atomically (one phase = one or more discrete commits with passing tests on each). To roll back:

**Code:** `git revert <sha>` for the offending commit, or `git revert <oldest>..<newest>` for a range. Push, redeploy.

**Schema:** Drizzle generates forward-only migrations. To roll back a phase's schema, run the inverse SQL manually:

| Phase | Forward (in `packages/db/drizzle/`) | Manual reverse |
|---|---|---|
| 6b.6 hardening | `0009_tg_msg_id_dedup.sql` | `DROP INDEX agent_runs_tg_msg_id_dedup_uidx;` |
| 6b.6 hardening | `0008_sse_tickets.sql` | `DROP TABLE sse_tickets;` |
| 6b.6 hardening | `0007_auth_issue_rate_buckets.sql` | `DROP TABLE auth_issue_rate_buckets;` |
| 6b.6 hardening | `0006_agent_runs_cache_creation.sql` | `ALTER TABLE agent_runs DROP COLUMN cache_creation_tokens;` |
| 6b | `0005_agent_runs.sql` | `DROP TABLE agent_runs;` |
| 6a | `0004_tokens.sql` | `DROP TABLE tokens;` |
| 6.0 | `0003_intel_events.sql` | `DROP TABLE intel_events;` |
| 5e | `0002_helius_webhooks.sql` | `DROP TABLE helius_webhooks; DROP TABLE watch_events; DROP TABLE watches;` |
| 5d | `0001_smart_money_pnl.sql` | `ALTER TABLE wallets DROP COLUMN realized_pnl_sol;` |
| 0–4 | `0000_clever_justin_hammer.sql` | drop the schema and re-bootstrap |

After manual SQL, also delete the corresponding row from `drizzle.__drizzle_migrations` so a future `bun run migrate` doesn't think the migration is still applied.

**Container:** `docker compose down && git checkout <good-sha> && docker compose up -d --build`. Postgres data persists in the named volume.

**Health check:** `curl http://localhost:3001/health` returns `{"ok":true,"db":"ok"}` when the API can reach Postgres. Add this to your container orchestrator's liveness probe.

### Monitoring (current state)

What ships in the box:

- `/health` endpoint with DB ping (200/503). Liveness probe target.
- HTTP request logging via `hono/logger` middleware (stdout, includes path + status + latency).
- `X-ThirdEye-Cache: HIT|MISS` and `X-ThirdEye-Proxy-Duration-Ms` response headers on all proxy routes.
- `agent_runs` audit table with per-run `cost_usd`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_tokens`, status, model — full Anthropic-cost reconstruction.
- `auth_tokens.rate_bucket` jsonb persists per-token + per-token-BYOK counters under `PUBLIC_INSTANCE_MODE` — readable as a time-series for abuse detection.
- `console.error`/`console.warn` lines at every catch site (rate-limit hits, scanner failures, watch sync failures, dispatch handler crashes, intel-bus malformed payloads, helius upstream errors, tg-bot polling 409 + getUpdates exponential backoff, fatal MCP errors).

Operator deploy checklist (gaps you must fill before public-instance traffic):

| Gap | Mitigation |
|---|---|
| No structured JSON logging | Pipe stdout through a JSON formatter at the deploy layer (Railway, Datadog agent, vector.dev). Pino integration is a v2 enhancement. |
| No metrics endpoint | The `agent_runs` and `auth_tokens.rate_bucket` columns are the canonical sources of truth — run scheduled SQL queries against them. Prometheus/OTEL exporters are a v2 enhancement. |
| No alerting on `/health` failures | Wire your platform's uptime monitor (UptimeRobot / Pingdom / Railway healthchecks) to `GET /health` with alert-on-5xx. |
| No alerting on rate-limit-bypass anomalies | Watch for sustained `auth_issue_rate_limited` log lines or `*_byok` bucket spikes via SQL: `SELECT token, rate_bucket FROM auth_tokens WHERE (rate_bucket->>'scan_token_byok')::jsonb->>'count' > '100';` |
| No alerting on agent daily-cost overshoot | The cap itself is enforced via Postgres advisory lock so cost cannot exceed `AGENT_DAILY_COST_USD_CAP`. Add a daily SQL check for `SUM(cost_usd) WHERE started_at > now() - interval '1 day'` and alert at >80% of cap. |
| No reverse-proxy in front of api | REQUIRED if you set `PUBLIC_INSTANCE_MODE=true`. The proxy must (a) set `X-Forwarded-For` with the real client IP and (b) strip any client-supplied `X-Forwarded-For`. Without (b), the H2 per-IP rate limit on `/api/db/auth` is bypassable by header spoofing. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). TL;DR: `bun install && docker compose up -d postgres && bun run migrate && bun test`. Linter, typechecker, and full test suite must be green before opening a PR.

## License

MIT
