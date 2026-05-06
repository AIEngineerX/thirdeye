# Phase 4 — Intel Analytics (Design)

Status: draft · Date: 2026-05-05 · Supersedes the bones in `2026-05-01-thirdeye-design.md` §8.3, §12, §13

## Goal

Pure aggregation over the shared DB — **zero Helius calls** for the read path. A `refresh-aggregates` cron recomputes 4 keyed payloads every 30s; an SSE feed pushes scan/check events to subscribed clients between refreshes; an hourly `enrich-wallet` cron re-checks aged tagged wallets. Drives the "Intel" v1 module: 24h pulse, all-time totals, 7-day risk histogram, recent-activity panels, top-20 heatmap.

This phase introduces graphile-worker (Postgres-backed job queue, no Redis) for cron + on-demand background work. v1 ships single-process self-host parity (worker + API in the same Bun event loop per spec §6).

## API

```
GET  /api/db/intel/aggregates              JSON — all 4 cached aggregate payloads
GET  /api/db/intel/recent/scans            JSON — paginated recent token_scans
GET  /api/db/intel/recent/checks           JSON — paginated recent wallet_checks
GET  /api/db/intel/feed?token=<X-Auth>     SSE — live scan/check activity events
```

Auth: `X-Auth-Token` header for the GET routes (Phase 0). The SSE feed accepts `?token=` query param because `EventSource` doesn't support custom headers (spec §12).

### Aggregates payload shape

```ts
GET /api/db/intel/aggregates → {
  pulse24h: {
    scans: number,
    checks: number,
    newClusters: number,    // funders.cluster_count incremented in last 24h
    newBundlers: number,    // wallets where 'BUNDLER' added to tags in last 24h
    updatedAt: ISO8601,
  },
  allTime: {
    walletsProfiled: number,    // count(wallets)
    tokensScanned: number,      // count(distinct token_scans.mint)
    clustersDetected: number,   // sum(funders.cluster_count) — total across all scans
    bundlersTagged: number,     // count(wallets where 'BUNDLER' in tags)
    updatedAt: ISO8601,
  },
  riskDist: {
    buckets: number[],    // length 10 — counts in [0,10), [10,20), ..., [90,100]
    windowDays: 7,
    total: number,
    updatedAt: ISO8601,
  },
  heatmap: {
    items: { mint, symbol, name, risk: number, verdict: string, scannedAt: ISO8601 }[],
    updatedAt: ISO8601,
  },
}
```

If a key has never been refreshed yet, the field is omitted (caller treats as "no data yet"). Initial population happens on first cron tick (within 30s of boot).

### SSE feed events

Per spec §12:

| Event | Payload | When |
|---|---|---|
| `scan:start` | `{ mint, symbol }` | Token scan dispatched |
| `scan:complete` | `{ id, mint, symbol, risk, sybilFlag }` | token_scans row written |
| `check:start` | `{ address }` | Wallet check dispatched |
| `check:complete` | `{ address, score, verdict }` | wallet_checks row written |
| `tag:applied` | `{ address, tag }` | Single-tag append to a wallet (v1.1 — no current path emits) |

Heartbeat: `event: ping\ndata: {}\n\n` every 15s (proxy keep-alive).

Connection limit: 1 SSE connection per session token — opening a second from the same token aborts the prior. Server tracks open streams in an in-process Map (single-process v1; LISTEN/NOTIFY-backed multi-process is v1.1).

## Pipeline

### Aggregator (apps/api/src/lib/aggregator.ts)

Pure SQL functions, one per key. Runs synchronously inside the cron handler. No Helius calls.

```ts
pulse24h(db) → Promise<Pulse24h>
  // 4 SELECTs against token_scans, wallet_checks, funders, wallets
allTime(db) → Promise<AllTime>
  // 4 SELECT count(*)
riskDist(db) → Promise<RiskDist>
  // SELECT width_bucket(risk_pct::numeric, 0, 100, 10), count(*)
  // FROM token_scans WHERE scanned_at >= now() - interval '7 days' GROUP BY 1
heatmap(db) → Promise<Heatmap>
  // SELECT mint, symbol, name, risk_pct, verdict, scanned_at
  // FROM token_scans ORDER BY scanned_at DESC LIMIT 20
```

### `refresh-aggregates` worker

Calls all 4 aggregator functions, UPSERTs `intel_aggregates` rows with current `updated_at`. Run every minute via graphile-worker crontab — spec §13 asks for 30s but graphile-worker uses standard 5-field minute-precision cron with no seconds field, so 60s is the floor without going off-cron. Sub-minute is a v1.1 enhancement (would use a self-rescheduling task with `run_at = now() + 30s`). The Intel SSE bus pushes scan/check events instantly, so the 60s vs 30s aggregate refresh delta is not user-visible. Total work per tick: ≤ 4 reads + 4 writes; sub-50ms even at 100k scans.

### `enrich-wallet` worker

Hourly cron. Picks 100 wallets where `last_checked < now() - interval '7 days' AND tags <> '{}'` ordered by `last_checked ASC`. For each, runs `checkWallet()` (existing Phase 2 pipeline) with the server's HELIUS_API_KEY. Skips if `HELIUS_API_KEY` is unset (logs warning; doesn't crash). Errors per-wallet are caught and logged — one bad wallet doesn't kill the batch.

Why this exists: tagged wallets are interesting to keep current. Untagged wallets are skipped to save credits (most wallets that get checked once are never checked again).

### Intel bus (apps/api/src/lib/intel-bus.ts)

A single in-process EventEmitter. Producers: `wallet/check.ts`, `token/scan.ts`. Consumers: SSE feed handler in `intel/feed.ts`.

```ts
type IntelEvent =
  | { event: "scan:start"; data: { mint: string; symbol: string | null } }
  | { event: "scan:complete"; data: { id: number; mint: string; symbol: string | null; risk: number; sybilFlag: boolean } }
  | { event: "check:start"; data: { address: string } }
  | { event: "check:complete"; data: { address: string; score: number; verdict: string } }
  | { event: "tag:applied"; data: { address: string; tag: string } };

export function publish(evt: IntelEvent): void;
export function subscribe(handler: (evt: IntelEvent) => void): () => void; // returns unsubscribe
```

Process-local — works for spec §6 self-host single-process. Multi-process splits (worker container separate from API container) need LISTEN/NOTIFY swap; v1.1 deferral.

## graphile-worker integration

Single Bun process running both Hono API and graphile-worker. Configured in `apps/api/src/workers/runner.ts`:

```ts
import { run } from "graphile-worker";

const runner = await run({
  connectionString: env.DATABASE_URL,
  taskList: {
    "refresh-aggregates": refreshAggregates,
    "enrich-wallet": enrichWallet,
  },
  crontab: `
    * * * * * refresh-aggregates ?fill=1m
    0 * * * * enrich-wallet ?fill=1h
  `,
});
```

graphile-worker auto-creates its `graphile_worker` schema on first run (no separate migration needed). `?fill=10s` backfills missed runs after restart.

For deploy: process exposes both HTTP and worker on the same port/event loop. Self-host single-container is unchanged. Hosted-instance horizontal scale is a deployment concern — splitting API and worker into two containers is `WORKER_ONLY=true` in worker pod, `WORKER_DISABLED=true` in API pod (deferred to spec §17 v2 deployments).

## Persistence

`intel_aggregates` (already in schema):

```sql
CREATE TABLE intel_aggregates (
  key         text PRIMARY KEY,        -- '24h_pulse' | 'all_time' | 'risk_dist' | 'heatmap'
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

UPSERT pattern: `INSERT … ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`.

## Test plan

Unit (`apps/api/tests/`):

- `aggregator.test.ts` — seed `token_scans`/`wallet_checks`/`wallets` with synthetic rows, assert each aggregator function returns expected counts/buckets/heatmap rows.
- `intel-bus.test.ts` — publish/subscribe roundtrip, unsubscribe stops delivery.
- `intel-routes.integration.test.ts` — GET aggregates after running refresh-aggregates once, assert payload schema; SSE feed: subscribe, publish, assert event delivered; second connection aborts first.

No new Helius integration coverage — Intel is zero-Helius by spec.

## Out of scope (deferred)

- **Multi-process intel-bus** — switch from in-process EventEmitter to Postgres LISTEN/NOTIFY when public-instance horizontal scale lands (v1.1+).
- **`tag:applied` event emitter** — no v1 path applies tags one-at-a-time; the wallet-check pipeline writes tags in a single batch. When v2 adds incremental tag sources (admin override, Bad Actors DB ingest), wire the emitter then.
- **Connection-limit observability** — log when a connection is preempted but no metrics export at v1.
- **Frontend** — Phase 5; this phase is backend + worker only.
- **Rate limit on `/intel/feed`** — SSE is server-push and connection-bounded; per-token connection cap (1) is the limit.

## What we're not copying from godmode

- Their analytics page is per-token only; ours is platform-wide (cross-token roll-ups).
- They have no live activity feed; we keep one because it makes the home page feel alive without polling.
