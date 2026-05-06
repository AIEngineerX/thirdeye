# Phase 5 — Alpha Extraction (Design)

Status: draft · Date: 2026-05-06 · Builds on Phases 0–4 (v1 backend complete)

## Goal

Turn the forensic data we collect (Phases 1–4) into actionable trading-edge signals. Phases 0–4 answered "what is this wallet/token?" Phase 5 answers "**what should I do about it, and when?**"

This is the layer between the raw forensic primitives and the eventual frontend (now Phase 6). It adds:

- **Sharper tag rules** tuned to current Solana memecoin behaviour (bundlers, snipers, fresh-wallet farming).
- **A working SYBIL signal** — Phase 2 designed cluster-CoV but always passed `null`; this phase makes it real.
- **A cross-token funder view** — already-captured `funders.cluster_count` exposed as an endpoint so "this funder roots clusters across N tokens" becomes queryable.
- **A `SMART_MONEY` tag** — realized SOL PnL across a wallet's swap history, computed from data we already fetch.
- **Realtime alerts via Helius webhooks** — flips the system from poll-driven to push-driven so users learn about wallet moves before others.

Everything here ships on top of the existing API surface; no breaking changes to Phase 2/3/4 routes.

## Where this fits in the roadmap

| Phase | Status |
|---|---|
| 0 Foundation | ✅ shipped |
| 1 Helius proxy | ✅ shipped |
| 2 Check Wallet | ✅ shipped |
| 3 Scan Token | ✅ shipped |
| 4 Intel Analytics | ✅ shipped |
| **5 Alpha Extraction (this doc)** | draft |
| 6 Frontend (Next.js, was P5 in earlier docs) | not started |
| v2 deferrals | unchanged: AI Assistant, Bad Actors DB, KOLs Spotted feed |
| v3 deferrals | unchanged: Federation |

The earlier Phase 2 design doc referenced "Phase 5 frontend"; that's renumbered to Phase 6.

## Sub-deliverables (shippable independently, recommended order)

### 5a — Tune tag thresholds + cache TTLs for alpha mode

Pure config changes. Zero new code, zero new endpoints. Constants below ground every claim against real Solana memecoin tempo (mid-2025 baseline; revisit when launch dynamics shift).

`packages/scanner/src/tags.ts`:

| Constant | Old | New | Rationale |
|---|---|---|---|
| `FRESH_AGE_DAYS` | 30 | **14** | Bundler wallets are typically 3–7 days old at launch, not 30 |
| `FRESH_TX_COUNT` | 50 | **20** | Captures "wallet did the funding round and waited" |
| `DISTRIBUTOR_RECIPIENTS` | 20 | **10** | Many bundles fan to 10–15; 20 misses smaller ops |
| `BUNDLER_MIN_SIZE` | 3 | **2** | 2-wallet clusters on a fresh mint are suspicious; tradeoff: more false positives on CEX cohorts (mitigated by the EXCHANGE tag still suppressing) |
| `TIME_WINDOW_MIN_TIGHT` | 3 | **2** | 2 wallets funded within 5 min on a new mint = strong signal |
| `SYBIL_MAX_COV` | 0.15 | 0.20 | Slightly more permissive |
| `SNIPER_MAX_GAP_SEC` | 60 | **30** | Real snipers are <30s; 60s catches normal active traders |
| `WHALE_USD` | 10_000 | **50_000** | $10k is dust on SOL; real whales are $50k+ |
| `WHALE_MAX_TOKENS` | 5 | **10** | 5 was over-restrictive |

`packages/scanner/src/tx-patterns.ts`:

| Constant | Old | New |
|---|---|---|
| `RAPID_FIRE_GAP_SEC` | 60 | **30** (mirror SNIPER_MAX_GAP_SEC) |

`packages/scanner/src/scan-token.ts`:

| Constant | Old | New |
|---|---|---|
| `SHARED_HOLDER_LIMIT` | 100 | **200** — paid Helius + 429 retry handles this |

`packages/scanner/src/check-wallet.ts`:

| Constant | Old | New |
|---|---|---|
| `BYOK_CLUSTER_LIMIT` | 200 | **300** — capture more bundlers |

`packages/helius/src/cache.ts`:

| Constant | Old | New |
|---|---|---|
| LRU `max` entries | 5_000 | **50_000** — funded-by entries are immutable, worth retaining |

`apps/api/src/env.ts` (with .env.example doc):

| Var | Old default | New default |
|---|---|---|
| `WALLET_CHECK_CACHE_HOURS` | 24 | **4** |
| `WALLET_CHECK_LIMIT` | 30 | **120** |
| `SCAN_TOKEN_CACHE_HOURS` | 1 | **5/60 ≈ 0.083** (5 min) — or refactor unit to minutes |
| `SCAN_TOKEN_LIMIT` | 3 | **60** |

Existing unit tests reference the old constants explicitly (e.g. score.test.ts has hard-coded expected scores keyed to `BUNDLER_MIN_SIZE=3`). Each test that bakes in a threshold gets updated alongside the constant — no semantic test changes, just expected-value updates where constants flow through.

### 5b — Implement cluster CoV (lights up SYBIL tag)

Phase 2 set `cluster.cov = null` everywhere because computing it requires per-sibling tx fetch (~50× the credit cost on shared mode). With paid Helius and BYOK, we can afford it.

**Mechanics**:
1. After `buildCluster()` returns siblings, take up to `COV_SAMPLE_SIZE` (default 50) of them.
2. For each, fetch the wallet's last `COV_TX_PER_WALLET` (default 20) parsed transactions via existing `client.transactions(addr, 20)`.
3. Extract SOL outflow amounts per wallet from `nativeTransfers` where `fromUserAccount === wallet`.
4. Compute mean per-wallet outflow. Skip wallets with <5 samples.
5. CoV = stddev(per-wallet means) / mean(per-wallet means). Need ≥3 wallets with ≥5 samples each, else `null`.
6. Wire CoV into `cluster` object before the `cluster` SSE event emits. SYBIL tag rule already gates on `cov !== null && cov < SYBIL_MAX_COV` — no rule change needed.

**Cost**: 50 wallets × 1 transaction fetch each = 50 extra Helius enhanced-tx calls per scan, bounded by per-scan Semaphore (already cap 10 concurrent). Acceptable on paid tier.

Add unit tests for the CoV computation (table-driven on synthetic mean arrays). Add an integration test that asserts a synthetic 5-wallet cluster with similar tx amounts produces a low CoV → SYBIL tag fires.

### 5c — Cross-token bundler view

`token_scans.persistScan()` already increments `funders.cluster_count` for each detected cluster root. We're collecting this data; we just don't expose it.

**New endpoints** (under `/api/db/intel/funders` since it's a read-only intel surface):

```
GET  /api/db/intel/funders/top-clustered?limit=20
→ {
    items: [{
      address: string,
      clusterCount: number,
      fanoutCount: number,
      firstSeen: ISO8601,
      lastSeen: ISO8601,
      // Bonus enrichment if we have it cached:
      identity: { name, type, category } | null,
    }]
  }

GET  /api/db/intel/funders/:addr/clusters
→ {
    funder: string,
    clusters: [{
      mint: string, symbol: string|null, name: string|null,
      scannedAt: ISO8601, riskPct: number, sybilFlag: boolean,
      memberCount: number,    // size of the cluster rooted at this funder in that scan
    }]
  }
```

The second endpoint requires extracting per-cluster member count from the persisted `token_scans.payload` jsonb (we have it, just need to project). For perf, consider denormalizing: add `funder_clusters` (funder_address, scan_id, member_count, mint, scanned_at) populated on persist. Decision: **do not denormalize for v1** — query the jsonb directly with `payload->'clusters'` filters. Postgres handles this efficiently up to ~10k rows; revisit if scan volume grows past that.

Both routes auth-gated under `requireAuth` in the existing `intelReadRouter` group.

### 5d — `SMART_MONEY` tag (realized SOL PnL)

A wallet that has consistently extracted SOL from token swaps over time is signal. Differentiates from BUNDLER (creating tokens) and SNIPER (mechanically fast).

**Schema migration** (drizzle):
```sql
ALTER TABLE wallets ADD COLUMN realized_pnl_sol numeric;
-- nullable; computed lazily when wallet is checked
```

**Computation** (added to scanner pipeline, after `txPattern`):
1. From the existing `transactions(addr, 100)` fetch, filter to SWAP events (`type === "SWAP"`).
2. For each swap, extract net SOL flow: sum `nativeTransfers` where SOL changes hands with the target. Positive = wallet received SOL (sold token), negative = wallet sent SOL (bought token).
3. `realizedPnlSol = sum(net SOL across SWAPs over the last 30d window)`.
4. New tag: `SMART_MONEY` if `realizedPnlSol >= 50` (configurable via `SMART_MONEY_MIN_SOL`).

**Tag interaction**:
- Score adjustment: `SMART_MONEY` subtracts 15 points (positive signal — this wallet's behaviour is competent, not predatory).
- Verdict cascade: insert `SMART_MONEY` between `WHALE` and `FRESH` in the cascade — high-PnL wallets that aren't bundlers/snipers are smart money first, whale second.

**Limitations** (documented in code, not bugs):
- 30-day window because we only fetch last 100 tx; long-time holders' realized PnL is hidden in older history (would need pagination).
- Doesn't account for unrealized PnL on current holdings (we'd need price feed integration).
- Can be gamed (bot loops sells back) but signal is still useful in aggregate.

Pagination + unrealized PnL = v1.1 enhancement.

### 5e — Helius webhook subscription (realtime alerts)

Helius webhooks push events when a watched address moves. Hooks the system into push-driven mode.

**Schema migrations**:
```sql
CREATE TABLE watches (
  id              bigserial PRIMARY KEY,
  address         text NOT NULL,
  label           text,
  token           text NOT NULL REFERENCES auth_tokens(token) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token, address)
);
CREATE INDEX watches_address_idx ON watches(address);

CREATE TABLE watch_events (
  id              bigserial PRIMARY KEY,
  address         text NOT NULL,
  signature       text NOT NULL,
  type            text,              -- "SWAP" | "TRANSFER" | "NFT_SALE" | etc
  payload         jsonb NOT NULL,    -- raw Helius event
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_events_address_idx ON watch_events(address, received_at DESC);
```

**API**:
```
POST   /api/db/watches  { addresses: [string], label?: string }
DELETE /api/db/watches/:address
GET    /api/db/watches               → list current user's watches
GET    /api/db/watches/:addr/events?limit=50  → recent events
POST   /api/helius-webhook  (public, signed)  ← Helius calls this
```

**Helius webhook lifecycle**:
1. On first `/api/db/watches` POST, server calls Helius `createWebhook` API with `webhookURL = ${PUBLIC_BASE_URL}/api/helius-webhook` and the address list.
2. Subsequent POSTs `getWebhookByID` + `updateWebhook` to merge into existing address list (Helius caps at 100k addresses per webhook on paid tier).
3. DELETE removes from local DB and updates Helius webhook to drop the address.
4. Webhook ID stored in a `helius_webhooks` table (single row): `{id, webhook_id, last_synced_at, address_count}`.

**Authentication of incoming webhook**: Helius supports a `Authorization` header set during `createWebhook`. Server stores the secret in env (`HELIUS_WEBHOOK_AUTH`); rejects events without it. No CSRF concern (Helius is the only caller).

**Event flow** (per inbound event):
1. Validate auth header.
2. Persist to `watch_events`.
3. Resolve to a `WatchEvent` shape: `{address, signature, type, summary}`.
4. Publish to existing `intel-bus` as a new `IntelEvent` variant: `{event: "watch:event", data: WatchEvent}`.
5. Connected SSE clients on `/api/db/intel/feed` see the event live.

**`/api/db/intel/feed` filter** (related v1.1 enhancement, deferred): `?watch=addr1,addr2` to filter the bus to specific addresses. For v1 of 5e, the feed broadcasts all watch events; clients filter.

**Out-of-scope for 5e**: outbound notifications (Discord/Telegram). The intel-bus event is the integration point — wire those in v1.1 when concrete channels are picked.

## Test plan

5a — Update existing score/tags/verdict unit tests to match new constants. Snapshot any new boundary cases (e.g. `FRESH_AGE_DAYS=14` boundary).

5b — Unit tests for `computeCov()` (we already have a stub). Add an integration test against the Phase 2 fixture wallet that asserts CoV is non-null when cluster size ≥ 3.

5c — Integration test: seed `token_scans` + `funders` with synthetic data, hit the endpoints, assert sort order and member counts. No Helius cost.

5d — Unit test the PnL extractor on synthetic swap arrays. Integration test against a wallet known to have realized swaps — Phase 2's fixture (`VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1`) has trade history; assert `realizedPnlSol` is a number (positive or negative — value depends on wallet's actual trades, just assert it's computed).

5e — End-to-end harder to test without staging deploy. Unit test the webhook event parser; integration test the watches CRUD and event ingestion handler with a synthetic Helius-shaped payload (the webhook payload schema is documented; we mock the Helius signature path with a known secret).

## Out of scope / explicit deferrals

- **Outbound notifications** (Discord/Telegram/email). The intel-bus is the integration point; consumers are out-of-band.
- **Per-address SSE feed filter** (`?watch=…`). v1.1.
- **Unrealized PnL** (needs price feed). v1.1.
- **Tx history beyond 100** for older PnL coverage (needs pagination — `before` cursor). v1.1.
- **Smart-money clustering** (find wallets that *trade alongside* known smart money). v2 — needs cross-wallet correlation infra.
- **AI agent / RL strategy layer**. v2 (was already in deferrals list).

## Order of execution

1. **5a — config tunes** (lowest risk, immediate gains for any user running Phase 2/3 today).
2. **5b — cluster CoV / SYBIL fix** (finishes a Phase 2 v1 promise that's been dead since launch).
3. **5c — funders/top-clustered** (1h, lights up cross-token bundler intel from existing data).
4. **5d — SMART_MONEY tag** (3–4h, needs schema migration; review weights against real wallets before merging).
5. **5e — Helius webhooks** (4–6h, biggest unlock; needs webhook URL and `HELIUS_WEBHOOK_AUTH` configured).

5a + 5b + 5c can ship in one PR. 5d wants its own PR (schema migration). 5e wants its own PR (new infra surface).

## Notes for the frontend (Phase 6)

Phase 6 will consume the new endpoints from this phase. Worth the frontend designer knowing about:

- `top-clustered funders` is the home page's "watch list candidates" panel.
- `SMART_MONEY` tag should render distinctly (positive — green) vs BUNDLER/SYBIL (negative — red).
- `watch:event` SSE events are the primary live-update vehicle for a "watchlist" page.
- The new tag thresholds change the volume/distribution of tags on existing wallets — UI counters that bake in old distributions (e.g. "we've tagged X bundlers") need to recompute after this lands.
