---
title: ThirdEye — Open-Source Solana Wallet Intelligence
date: 2026-05-01
status: Draft
license: MIT
---

# ThirdEye

> *The eye that sees what the other two cannot.*

Open-source Solana wallet & token forensics — bundle/sybil detection, funding-chain tracing, cluster analysis.

---

## 1. What it is

Three tools, one shared intelligence database:

1. **Check Wallet** — paste a wallet, get a forensic profile: funding chain, behavioral tags, related wallets (cluster), risk verdict.
2. **Scan Token** — paste a token mint, get holder distribution clustered by first funder. Surfaces bundles, sybil rings, LP/lock breakdown.
3. **Intel Analytics** — network-wide rollup: 24h pulse, all-time totals, risk distribution, recent scans/checks feed, **heatmap** (20 most recent token scans as a risk-colored grid).

Shared DB grows with every scan. Self-hosters start fresh; public instance accumulates.

## 2. Goals

- Ship three core modules in v1 — Check Wallet, Scan Token, Intel Analytics — with AI Assistant, Bad Actors DB, and KOLs Spotted deferred to v2
- Run as a single `docker compose up` for self-hosters
- Run as a public hosted instance with rate-limited free access + BYOK bypass
- Operationally simple: Postgres-only infra, no Redis
- MIT-licensed, welcoming to OSS contributors

## 3. Non-goals (v1)

- AI Assistant chat → v2
- Bad Actors curated DB → v2
- KOLs Spotted feed → v2 (needs external KOL identity source)
- Federation / opt-in cross-instance sync → v3
- Mobile-native apps (web stays mobile-responsive)

## 4. Hosting model

**Public hosted + self-host, same codebase.**

| Mode | Helius key source | Auth & rate limits | DB |
|---|---|---|---|
| Public instance | Maintainer's key (`HELIUS_API_KEY` env var) | Anonymous session token, rate limits enforced | Shared, accumulating |
| Public + BYOK | User's key (`X-User-Helius-Key` header) | Same anon token; ThirdEye rate limits bypassed | Same shared DB |
| Self-host | Operator's key (`HELIUS_API_KEY` env var) | Anonymous session token; rate limits off by default (`PUBLIC_INSTANCE_MODE=false`) | Local, starts fresh |

`HELIUS_API_KEY` env var on the server, `X-User-Helius-Key` header from clients with BYOK. Server uses the header if present, falls back to env var. Client code never branches on which key is in play.

The public/self-host distinction is purely a config switch: `PUBLIC_INSTANCE_MODE=true` enables anonymous-token rate limiting; default `false` runs unmetered. Same image, same code path.

## 5. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun | Native TS, ~3x Node HTTP perf, single binary, built-in test runner |
| API framework | Hono | Portable, fast, middleware-rich |
| Frontend | Next.js 16 (App Router) | SSR for SEO, RSC for streaming live feeds |
| ORM | Drizzle | TS-native, lightweight, no codegen |
| DB | Postgres 16 | Shared intelligence cache |
| Job queue | graphile-worker | Postgres-backed, no Redis dependency |
| Realtime | SSE | Simpler than WebSocket, perfect for one-way feeds |
| Solana RPC | Helius (REST + JSON-RPC) | funded-by, identity, balances, parsed tx |
| Solana primitives | `bs58` + `@solana/addresses` | Address validation & parsing only (read-only product, no signing) |
| Wallet connect | `@solana/wallet-standard` | Phantom, Solflare, Backpack |

`docker compose` brings up two services: `app` + `postgres`.

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (Next.js)                                           │
│    ├─ session token in sessionStorage                        │
│    └─ optional BYOK key in localStorage                      │
└────────────────┬─────────────────────────────────────────────┘
                 │ HTTPS
┌────────────────▼─────────────────────────────────────────────┐
│  Bun + Hono API                                              │
│    ├─ /api/db/*    ─┐                                        │
│    ├─ /api/helius/* ┼─► reads X-User-Helius-Key OR env var   │
│    └─ /api/db/intel/feed (SSE)                               │
└──────────┬────────────────────────┬──────────────────────────┘
           │ SQL                     │ HTTPS
┌──────────▼─────────┐      ┌────────▼─────────┐
│  Postgres          │      │  Helius          │
│  (intel cache)     │      │  (REST + RPC)    │
└──────────▲─────────┘      └──────────────────┘
           │
┌──────────┴─────────┐
│  graphile-worker   │ ─► scan-token, check-wallet,
│  (background jobs) │    refresh-aggregates, enrich-wallet
└────────────────────┘
```

Self-host: single Bun process runs Hono API + graphile-worker in the same event loop (no child process, no separate container). Public instance: API and worker can be split into two Bun processes sharing the Postgres for horizontal scaling. Split is a deployment decision, not a code change.

## 7. Auth model

Anonymous session token:

- `POST /api/db/auth` returns `{ token, expiresAt }` for any browser session
- Stored in `sessionStorage`, sent as `X-Auth-Token` header on every API call
- Rate limits applied per token (see §16)
- On 401, client auto-reauths transparently
- Wallet connect is **optional and orthogonal** — used only for "this is my wallet" labeling and saving preferences, never for auth

## 8. Modules

### 8.1 Check Wallet

**Input**: Solana wallet address (base58).

**Pipeline**:
1. Cache lookup: `GET /wallet/:addr/last-check` — if fresher than 24h, return cached. Bypass with `?force=true` query param.
2. Helius `/v1/wallet/:addr/funded-by` → first funder + funding signature → resolve `funded_at` via `getTransaction` (block times immutable, cache forever)
3. Helius `/v1/wallet/:addr/balances?limit=100&showNative=true` → SOL + tokens
4. Helius `/v0/addresses/:addr/transactions?limit=100` → recent activity sample
5. Behavioral classifier → tags (see table below)
6. Cluster lookup: `SELECT address FROM wallets WHERE first_funder = $1` where `$1` = `first_funder` from step 2
7. Score (0–100, higher = riskier) — see formula below
8. Save: `POST /wallet`, `POST /wallet-check`

**Wallet score formula (v1)**:
```
wallet_score = clamp(
    (has FRESH_WALLET    ? 10 : 0)
  + (has FUND_DISTRIBUTOR ? 20 : 0)
  + (has BUNDLER          ? 35 : 0)
  + (has SYBIL            ? 50 : 0)
  - (has KOL              ? 10 : 0)         // KOLs are reputation-positive
  + min(cluster_size, 50) * 0.5,
  0, 100)
```

**Verdict thresholds**: `CLEAN` 0–20 · `LOW` 21–45 · `MEDIUM` 46–70 · `HIGH` 71–100

**Behavioral tags** (initial pass — refinable in v1.1):

| Tag | Definition |
|---|---|
| `FRESH_WALLET` | Age < 30 days AND tx_count < 50 |
| `FUND_DISTRIBUTOR` | Outbound SOL to > 20 unique recipients |
| `BUNDLER` | Member of a cluster of ≥ 5 wallets sharing same funder, all funded within 60s of each other |
| `SYBIL` | Wallet's funder is itself the funder of ≥ 2 BUNDLER clusters |
| `KOL` | Stub for v2 (requires identity source) |

### 8.2 Scan Token

**Input**: token mint (base58).

**Pipeline**:
1. Cache lookup: `GET /token/:mint/scans/latest` — if fresher than 1h, return cached. Bypass with `?force=true`.
2. Helius `getTokenHolders` → top N holders by balance (N = `SCAN_HOLDER_LIMIT` env var, default `200`)
3. LP/lock filter: cross-reference holder list against `packages/shared/programs.json` (Raydium AMM v4, Meteora DLMM/DAMM, Orca Whirlpools, Jupiter, Streamflow, Tokenlocker). Tag separately, exclude from cluster pass.
4. For each remaining holder, Helius `funded-by` — concurrency cap **10 in-flight per scan**, **50 in-flight per process**
5. Group holders by funder → clusters
6. Cross-ref cluster wallets against existing scan DB to enrich with prior tags
7. Compute supply % per cluster, total clustered %, risk %, SYBIL flag
8. Save: `POST /scan` + `POST /wallets/batch-save`

**Output**:
- Holders: top N with %, tags, cluster ID
- Clusters: list with size, total %, root funder, sample wallets
- LP/lock: separate breakdown
- Verdict: `CLEAN` / `LOW_RISK` / `HIGH_RISK` with score 0–100

**Risk score formula (v1)**:
```
risk = clamp(
    total_clustered_pct * 1.0
  + (sybil_flag        ? 25 : 0)
  + (max_cluster_pct > 5 ? 15 : 0)
  + (fresh_funder_count / max(total_clusters, 1)) * 10,
  0, 100)
```

Where:
- `total_clustered_pct` — sum of supply % across all detected clusters (excludes LP/lock)
- `sybil_flag` — `true` if any single cluster's `total_pct ≥ 5%` of supply (token-level)
- `max_cluster_pct` — largest cluster's supply %
- `fresh_funder_count` — count of clusters whose root funder is itself tagged `FRESH_WALLET`
- `total_clusters` — number of distinct clusters in the scan

**Verdict thresholds**: `CLEAN` 0–10 · `LOW_RISK` 11–35 · `HIGH_RISK` 36–100

### 8.3 Intel Analytics

Pure aggregation over the shared DB — **zero Helius calls**.

- 24h pulse: scans, wallet checks, new clusters, new bundlers (counts in last 24h)
- All-time totals: wallets profiled, tokens scanned, clusters detected, bundlers tagged
- Risk distribution: histogram of `risk_pct` over the last 7 days of scans (10-bucket histogram, bucket width 10%)
- Recent scans + recent wallet checks (paginated)
- **Heatmap**: 20 most recent token scans as a risk-colored grid (color scale by risk_pct)

Aggregates regenerated every 30s by a `refresh-aggregates` cron job. Page subscribes via SSE for live updates between regenerations.

## 9. Data model (Postgres)

```sql
-- Anonymous session tokens
CREATE TABLE auth_tokens (
  token         text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  rate_bucket   jsonb NOT NULL DEFAULT '{}'::jsonb  -- token-bucket counters keyed by limit name
);

-- Wallets (cached profiles)
CREATE TABLE wallets (
  address       text PRIMARY KEY,
  first_funder  text,
  funded_at     timestamptz,
  sol_balance   numeric,
  usd_value     numeric,
  tx_count      integer,
  age_days      integer,
  tags          text[] NOT NULL DEFAULT '{}',
  last_checked  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_first_funder_idx ON wallets(first_funder);
CREATE INDEX wallets_tags_idx ON wallets USING gin(tags);

-- Wallet checks (history of /wallet-check writes)
CREATE TABLE wallet_checks (
  id            bigserial PRIMARY KEY,
  address       text NOT NULL REFERENCES wallets(address),
  score         integer NOT NULL,
  verdict       text NOT NULL,                       -- CLEAN | LOW | MEDIUM | HIGH
  payload       jsonb NOT NULL,                      -- full Check Wallet response shape (§8.1 output)
  checked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_checks_address_idx ON wallet_checks(address, checked_at DESC);

-- Token scans (history of /scan writes)
CREATE TABLE token_scans (
  id              bigserial PRIMARY KEY,
  mint            text NOT NULL,
  symbol          text,
  name            text,
  launchpad       text,
  total_holders   integer,
  scanned_holders integer,
  cluster_count   integer,
  clustered_pct   numeric,
  lp_pct          numeric,
  locked_pct      numeric,
  risk_pct        numeric,
  sybil_flag      boolean NOT NULL DEFAULT false,
  verdict         text,                              -- CLEAN | LOW_RISK | HIGH_RISK
  payload         jsonb NOT NULL,                    -- full Scan Token response shape (§8.2 output)
  scanned_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX token_scans_mint_idx ON token_scans(mint, scanned_at DESC);

-- Funders (denormalized for fast funder-fanout queries)
CREATE TABLE funders (
  address       text PRIMARY KEY,
  fanout_count  integer NOT NULL DEFAULT 0,
  cluster_count integer NOT NULL DEFAULT 0,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX funders_fanout_idx ON funders(fanout_count DESC);
-- fanout_count: incremented on every wallet UPSERT touching this funder
-- cluster_count: recomputed at end of each `scan-token` job (count of distinct clusters this funder rooted in this scan, summed)

-- Aggregates (refreshed every 30s by cron)
CREATE TABLE intel_aggregates (
  key         text PRIMARY KEY,  -- '24h_pulse', 'all_time', 'risk_dist', 'heatmap'
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

## 10. API contract

All routes namespaced under `/api/*`.

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/db/auth` | Issue anonymous session token |

### Wallet (read)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/db/wallet/:addr` | Cached wallet profile |
| GET | `/api/db/wallet/:addr/last-check` | Most recent check |
| GET | `/api/db/wallet/:addr/checks` | Check history |
| GET | `/api/db/wallet/:addr/connections` | Wallets sharing this funder |
| GET | `/api/db/wallet-checks?limit=50` | Recent checks across all wallets |
| GET | `/api/db/wallets/tagged/:tag?limit=50` | Wallets with a given tag |

### Wallet (write)
| Method | Path | Body |
|---|---|---|
| POST | `/api/db/wallet` | Upsert wallet |
| POST | `/api/db/wallet-check` | Save a check result |
| POST | `/api/db/wallets/batch-save` | `{ wallets: [...] }` |
| POST | `/api/db/wallets/batch-tag` | `{ tags: [{address, tag}] }` |

### Wallet (analysis)
| Method | Path | Body |
|---|---|---|
| POST | `/api/db/wallets/cross-analysis` | `{ addresses: [...] }` → relationship graph |
| POST | `/api/db/wallets/funder-fanout` | `{ funders: [...], windowSec }` → wallets funded within window |
| POST | `/api/db/wallets/scan-cache` | `{ addresses: [...] }` → bulk cache lookup |
| POST | `/api/db/wallets/batch` | `{ addresses: [...] }` → bulk wallet info |

### Funder
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/db/funder/:addr/profile` | Funder profile |
| GET | `/api/db/funder/:addr/network` | Funder's network graph |

### Token
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/db/token/:mint` | Token info |
| GET | `/api/db/token/:mint/scans` | Scan history for this mint |
| GET | `/api/db/scans?limit=50` | Recent scans across all tokens |
| GET | `/api/db/scan/:id` | Specific scan |
| POST | `/api/db/scan` | Save scan |

### Intel
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/db/intel/stats` | Counters + 24h pulse |
| GET | `/api/db/intel/analytics` | Full analytics (heatmap source) |
| GET | `/api/db/intel/feed` | SSE event stream |

### Helius proxy (key held server-side; BYOK via header)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/helius/v1/wallet/:addr/identity` | |
| GET | `/api/helius/v1/wallet/:addr/balances` | `?limit=100&showNative=true` |
| GET | `/api/helius/v1/wallet/:addr/funded-by` | The cluster primitive |
| GET | `/api/helius/v0/addresses/:addr/transactions` | `?limit=100&...` |
| POST | `/api/helius/v1/wallet/batch-identity` | `{ addresses: [≤100] }` |
| POST | `/api/helius/v0/transactions` | `{ transactions: [signatures] }` |
| POST | `/api/helius-rpc` | `{ jsonrpc, method, params }` raw RPC pass-through |

## 11. Cluster algorithm

The whole bundle/sybil-detection system reduces to one Helius primitive plus one Postgres query:

```
For each new wallet observed:
  funder = Helius `/v1/wallet/:addr/funded-by`
  UPSERT wallets (address, first_funder) VALUES (...)
    ON CONFLICT (address) DO UPDATE SET first_funder = EXCLUDED.first_funder
  UPSERT funders (address, fanout_count) VALUES (funder, 1)
    ON CONFLICT (address) DO UPDATE SET fanout_count = funders.fanout_count + 1,
                                          last_seen = now()

For cluster detection on a token scan:
  for each holder: ensure first_funder is known
  cluster_map = SELECT first_funder, array_agg(address) FROM wallets
                WHERE address = ANY($holders) GROUP BY first_funder
  for each cluster: compute total_pct (sum of holder % in this cluster)
  token.sybil_flag = (MAX(cluster.total_pct) >= 5)   -- token-level boolean

For wallet check cluster context:
  funder = wallet's first_funder
  cluster = SELECT * FROM wallets WHERE first_funder = funder
  return size + sample (capped at 50)
```

Every scan enriches the graph. The "bundlers tagged" stat is just the count of wallets where `'BUNDLER' = ANY(tags)`.

## 12. Real-time feed (SSE)

Endpoint: `GET /api/db/intel/feed`. Events emitted by API after writes:

| Event | Payload | When |
|---|---|---|
| `scan:start` | `{ mint, symbol }` | Token scan job dequeued |
| `scan:complete` | `{ id, mint, symbol, risk_pct, sybil_flag }` | Scan saved |
| `check:start` | `{ address }` | Wallet check job dequeued |
| `check:complete` | `{ address, score, verdict }` | Check saved |
| `tag:applied` | `{ address, tag }` | Tag added to a wallet |

Home page subscribes; Intel module live-renders the recent activity panels and updates the heatmap on each `scan:complete`.

**Auth**: `EventSource` doesn't support custom headers, so the session token is passed as `?token=<X-Auth-Token>` query param. Endpoint validates the token before upgrading to a streaming response.

**Heartbeat**: server emits `event: ping\ndata: {}\n\n` every 15 seconds to keep proxies and load balancers from closing idle streams.

**Connection limit**: 1 SSE connection per session token; new connection from same token closes the prior one.

## 13. Background jobs (graphile-worker)

| Job | Cadence | Purpose |
|---|---|---|
| `scan-token` | On demand (queued from `/api/db/scan` POST) | 30–90s pipeline §8.2 |
| `check-wallet` | On demand | 5–30s pipeline §8.1 |
| `refresh-aggregates` | Every 30s (cron) | Recompute `intel_aggregates` rows |
| `enrich-wallet` | Hourly (cron) | Re-check wallets where `last_checked < now() - interval '7 days'` AND `tags <> '{}'`. **Batch size: 100 wallets per run**, ordered `last_checked ASC` (oldest first). Skips never-tagged wallets to save credits. |

## 14. Repo layout

```
thirdeye/
├── apps/
│   ├── web/                    # Next.js 16 frontend
│   └── api/                    # Bun + Hono backend (API + worker host)
├── packages/
│   ├── db/                     # Drizzle schema, migrations
│   ├── helius/                 # Helius client + types
│   └── shared/                 # Shared types, constants
├── docker-compose.yml          # app + postgres
├── .env.example
├── README.md
└── LICENSE                     # MIT
```

Bun workspaces, single git repo.

## 15. Deployment

**Public instance**: platform TBD (Railway / Fly.io / VPS Docker — pick during phase 1). Single Postgres, single Bun app process, separate worker process for scaling.

**Self-host**: `docker compose up`. Two services. One required env var: `HELIUS_API_KEY`. Optional: `PUBLIC_INSTANCE_MODE=false` (default; turning on enables rate limits even for self-host).

## 16. Rate limits & caching

**Anonymous session tokens (public instance only, when `PUBLIC_INSTANCE_MODE=true`)**:
- 30 token scans per session token per hour
- 30 wallet checks per session token per hour
- 200 cache reads per session token per minute
- BYOK header bypasses ThirdEye's limits (Helius's own rate limits on the user's key still apply naturally)
- Optional IP-based throttle layered on top at the reverse-proxy / Cloudflare level (deployment concern, not code)

**Cache TTLs**:
- Wallet check: 24h (re-check forced via UI button)
- Token scan: 1h
- Helius proxy responses: 5min in-memory LRU
- Intel aggregates: 30s

## 17. v2 deferrals (explicit list)

- AI Assistant — adds `/api/db/intel/ai`, model TBD (xAI Grok or Anthropic)
- Bad Actors curated DB — adds `/bad-actors` page + `bad_actors` table + admin endpoints
- KOLs Spotted feed — needs Twitter handle → wallet identity source
- Federation / opt-in cross-instance sync — pull/push protocol, dedup, abuse handling

## 18. Risks / open questions

- **Helius credit cost**: 200-holder scan ≈ 200 × `funded-by` calls. Need to monitor and consider aggressive caching of funder lookups. Funders rarely change → cache per `(address, first_funder)` pair forever once observed.
- **Public instance abuse**: anonymous tokens are mintable. May need IP-based throttling layered on top of token-based limits at deploy time.
- **Public instance ops**: maintainer pays the Helius bill. v1 stays cheap; if scans accelerate, BYOK incentives + a tip-jar (SOL address) cover it.
- **Directory rename**: working dir is `V:\Ghost Wallet Tracker`. Recommendation: rename to `V:\thirdeye` at git init time. Defer for now; flagged.
- **Frontend visual direction**: explicitly TBD. This spec covers backend + module behavior. A separate frontend visual spec to be written when we reach that phase, after the arcane / mystic / brutalist direction is locked.
