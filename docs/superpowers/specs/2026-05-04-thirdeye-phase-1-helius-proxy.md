# ThirdEye Phase 1 — Helius Proxy Design Spec

**Status:** approved 2026-05-04 · **Author:** brainstorming with user · **Parent spec:** [`2026-05-01-thirdeye-design.md`](./2026-05-01-thirdeye-design.md)

This document is the design output for Phase 1 of ThirdEye. It is the source of truth for the implementation plan that follows in `docs/superpowers/plans/2026-05-04-thirdeye-phase-1-helius-proxy.md`. Where this document and the parent spec disagree, **this document wins for Phase 1 scope** and the parent spec is amended in the same commit.

## 1. Goal

Implement the seven `/api/helius/*` proxy endpoints listed in the parent spec §10, plus the JSON-RPC pass-through at `/api/helius-rpc`, with:

- Server-side `HELIUS_API_KEY` hidden from clients
- Per-user BYOK via `X-User-Helius-Key` header (overrides server key, bypasses ThirdEye rate limits)
- In-memory LRU cache with two TTL tiers — 5-min default, 24h for known-immutable endpoints
- Per-session-token sliding-window rate limit (600/hour) on the proxy, enforced only when `PUBLIC_INSTANCE_MODE=true` and no BYOK header
- A reusable rate-limit middleware that Phase 2/3 declare new limit names against
- Real Helius integration tests in CI (per `CLAUDE.md` no-mocks rule)

## 2. Non-goals (this phase)

- Helius WebSocket / LaserStream proxying — not in spec §10's enumerated endpoints
- Wallet-check or token-scan business logic — Phase 2 and Phase 3
- Frontend — Phase 6+ (originally written as Phase 5; renumbered when Phase 5 became Alpha Extraction)
- Worker process — Phase 2 introduces graphile-worker, but this phase's primitive is designed to be importable from a worker without HTTP round-trip

## 3. Endpoint shape (decision Q1: hybrid)

Six explicit REST handlers + one method-gated JSON-RPC handler. Each REST handler validates inputs (Solana address shape, body schema) before forwarding. The RPC handler enforces a deny-list (Q4) and otherwise passes through.

| Method | Path | Helius target | Cache TTL |
|---|---|---|---|
| GET | `/api/helius/v1/wallet/:addr/identity` | `api.helius.xyz/v1/wallet/{addr}/identity` | 5 min |
| GET | `/api/helius/v1/wallet/:addr/balances` | `api.helius.xyz/v1/wallet/{addr}/balances` (`?limit=100&showNative=true`) | 5 min |
| GET | `/api/helius/v1/wallet/:addr/funded-by` | `api.helius.xyz/v1/wallet/{addr}/funded-by` | **24h (immutable)** |
| GET | `/api/helius/v0/addresses/:addr/transactions` | `api.helius.xyz/v0/addresses/{addr}/transactions` | 5 min |
| POST | `/api/helius/v1/wallet/batch-identity` | `api.helius.xyz/v1/wallet/batch-identity` body `{ addresses: [≤100] }` | 5 min |
| POST | `/api/helius/v0/transactions` | `api.helius.xyz/v0/transactions` body `{ transactions: [signatures] }` | **24h (immutable)** |
| POST | `/api/helius-rpc` | `mainnet.helius-rpc.com/` body is JSON-RPC envelope | 5 min default; **24h** for immutable methods |

**Immutable RPC methods** (cache 24h): `getTransaction`, `getBlock`, `getBlockTime`, `getSignatureStatuses`. All other allowed methods cache 5 min.

**RPC deny-list** (Q4 decision B): `sendTransaction`, `simulateTransaction`, `requestAirdrop`. Anything else flows through.

## 4. Rate limiting (decision Q2: build the primitive in Phase 1)

**Storage:** `auth_tokens.rate_bucket` jsonb (already exists from Phase 0).

**Algorithm:** sliding window. One named limit per jsonb key:

```jsonc
{
  "helius_proxy": { "windowStart": "2026-05-04T13:00:00Z", "count": 47 }
}
```

**Phase 1 introduces one limit:** `helius_proxy` — 600 requests / 3600 seconds. Sized to comfortably support 30 token scans × ~20 calls/scan (the scan rate limit Phase 3 will add).

**Bypass conditions** (either causes the middleware to no-op):
1. `PUBLIC_INSTANCE_MODE !== "true"` (self-host default)
2. `X-User-Helius-Key` header present **and** the middleware was constructed with `bypassOnByok: true`

The factory exposes an explicit `bypassOnByok` flag so future phases can decide per limit name. Phase 1 uses `bypassOnByok: true` for `helius_proxy` (it protects server credits — BYOK has its own bill via Helius). Phase 2/3 will use `bypassOnByok: false` for `wallet_check` and `scan_token` (those protect server compute and product UX, not credits).

**SQL:** single atomic UPDATE per request via `jsonb_set` with a CASE for window-rollover. Returns the new count for the response headers (`X-RateLimit-*`).

**Reusable factory:**
```typescript
rateLimit({ name: "helius_proxy", limit: 600, windowSec: 3600, bypassOnByok: true })
```
Phase 2 adds `wallet_check` (30/3600, `bypassOnByok: false`). Phase 3 adds `scan_token` (30/3600, `bypassOnByok: false`). Phase 2/3 also add `cache_read` (200/60, `bypassOnByok: false`) on `/api/db/*` reads.

**On exceeded:** 429 with `{ error: "rate_limited", retryAfterSec, name }`, `Retry-After` header.

## 5. The proxy primitive (decision Q5: single `proxyToHelius`)

Lives at `packages/helius/src/proxy.ts`. Imported by every API route handler and by future Phase 2 worker code.

```typescript
type ProxyTarget =
  | { kind: "rest"; path: string; query?: Record<string, string> }
  | { kind: "rpc"; method: string; params: unknown[] };

interface ProxyOptions {
  target: ProxyTarget;
  method: "GET" | "POST";
  body?: unknown;
  cacheTtlMs: number;       // 0 disables caching
  serverKey: string;
  userKey?: string;         // BYOK
  timeoutMs?: number;       // default 10_000
}

interface ProxyResult {
  status: number;
  body: unknown;
  fromCache: boolean;
  durationMs: number;
  isByok: boolean;
}
```

### Per-call flow

1. **Resolve key** — `userKey ?? serverKey`. If neither, throw `NO_HELIUS_KEY` (handler maps to 503).
2. **Compose URL** — REST → `https://api.helius.xyz{path}?api-key={key}&{query}`. RPC → `https://mainnet.helius-rpc.com/?api-key={key}`. Same host split as `helius-labs/helius-rpc-proxy`.
3. **Cache lookup** — key = `sha256(method + canonicalPath + sortedQuery + canonicalBody)`. **Not keyed by API key.** BYOK and server-key responses are interchangeable in the cache.
4. **Hit** → return cached result, `fromCache: true`.
5. **Miss** → `fetch` with `AbortController` timeout, attach `X-ThirdEye-Proxy: 1` header.
6. **Helius 2xx** → buffer body, write to cache (only if `cacheTtlMs > 0`), return.
7. **Helius 429** → pass through 429, do not cache.
8. **Helius 4xx (other)** → pass through status + body, do not cache.
9. **Helius 5xx** → return ThirdEye 502 `{ error: "upstream_error", upstreamStatus }`, do not cache.
10. **Timeout / network** → return ThirdEye 504 `{ error: "upstream_timeout" }`, do not cache.

### What lives outside the primitive

- Auth middleware — Phase 0, unchanged
- Rate-limit middleware — runs **before** the route handler, sees BYOK header for bypass logic
- Input validation — each route handler validates address / body / RPC method before calling the primitive

## 6. Cache implementation (decision Q3: two-tier TTL)

**Library:** [`lru-cache`](https://www.npmjs.com/package/lru-cache) v11+. Single process-wide instance.

**Configuration:**
```typescript
new LRUCache<string, CachedResponse>({
  max: 5000,                    // entry cap
  ttl: 5 * 60 * 1000,           // default; per-call ttl overrides via .set(k, v, { ttl })
  ttlAutopurge: true,
  updateAgeOnGet: false,        // immutable-tier entries don't get extended on access
});
```

**TTL declarations** at `packages/helius/src/ttl.ts`:
```typescript
export const TTL = {
  IMMUTABLE: 24 * 60 * 60 * 1000,
  DEFAULT:    5 * 60 * 1000,
  NO_CACHE:   0,
} as const;

export const RPC_IMMUTABLE_METHODS: ReadonlySet<string> = new Set([
  "getTransaction", "getBlock", "getBlockTime", "getSignatureStatuses",
]);
```

**Justification for IMMUTABLE tier:** Helius Wallet API endpoints cost 100 credits each (verified via `getRateLimitInfo` against live billing docs). A token scan with 200 holders fires 200 `funded-by` calls = 20,000 credits per uncached scan. With the 24h immutable tier, repeat scans of overlapping addresses cost ~zero. This is a small spec amendment to parent §16's uniform 5-min — well-justified by call-pattern evidence.

## 7. Module layout

### New workspace package `packages/helius/`

```
packages/helius/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            # public exports
    ├── proxy.ts            # proxyToHelius(opts) — the chokepoint
    ├── cache.ts            # LRU instance + sha256 key composition
    ├── urls.ts             # Helius URL composition for REST + RPC
    ├── rpc-policy.ts       # JSON-RPC deny-list + envelope validation
    ├── ttl.ts              # tier constants + RPC_IMMUTABLE_METHODS set
    └── errors.ts           # error mapping (Helius status → ThirdEye shape)
```

### `apps/api` additions

```
apps/api/src/
├── env.ts                  # MODIFY — add HELIUS_API_KEY (optional)
├── index.ts                # MODIFY — mount /api/helius and /api/helius-rpc
├── lib/
│   └── solana-address.ts   # NEW — base58 + length validation
├── middleware/
│   └── rate-limit.ts       # NEW — sliding-window middleware factory
└── routes/
    └── helius/
        ├── index.ts        # NEW — barrel + mountHelius(app, deps)
        ├── identity.ts     # NEW
        ├── balances.ts     # NEW
        ├── funded-by.ts    # NEW
        ├── transactions.ts # NEW
        ├── batch-identity.ts
        ├── transactions-by-sig.ts
        └── rpc.ts
```

### Test files

```
apps/api/tests/
├── solana-address.test.ts          # unit
├── rate-limit.test.ts              # DB integration
├── helius-cache.test.ts            # unit (LRU + key composition)
├── helius-urls.test.ts             # unit
├── helius-rpc-policy.test.ts       # unit
├── helius-errors.test.ts           # unit
├── helius-proxy.integration.test.ts        # real Helius — skips when no HELIUS_API_KEY
└── helius-routes.integration.test.ts       # real Helius — skips when no HELIUS_API_KEY
```

Integration tests that need real Helius detect missing `HELIUS_API_KEY` at `beforeAll` and call `test.skip(...)` for each case. CI requires the key as a GitHub secret; local dev runs without if not configured.

## 8. Error handling

Uniform response shape:
```jsonc
{ "error": "<category>", "message": "<human readable>", "upstreamStatus": <int?>, "retryAfterSec": <int?> }
```

All Phase 1-introduced errors use snake_case error codes for machine readability. Phase 0's existing auth-middleware messages (`"missing X-Auth-Token"`, `"invalid token"`, `"token expired"`) are kept as-is; normalizing them is out of scope for this PR.

| Condition | ThirdEye status | `error` |
|---|---|---|
| Rate limit exceeded | 429 | `rate_limited` |
| No Helius key (neither env nor BYOK) | 503 | `no_helius_key` |
| Invalid Solana address | 400 | `invalid_address` |
| Invalid JSON-RPC envelope | 400 | `invalid_rpc_body` |
| Disallowed RPC method | 403 | `forbidden_rpc_method` |
| Helius 4xx (passthrough) | same | `upstream_<status>` |
| Helius 5xx | 502 | `upstream_error` |
| Timeout / network error | 504 | `upstream_timeout` |

## 9. Telemetry

Single structured JSON line per Helius call, written to stdout:
```jsonc
{ "ts":"2026-05-04T13:42:11.234Z", "type":"helius_proxy",
  "path":"/v1/wallet/.../funded-by", "method":"GET",
  "status":200, "durationMs":142, "fromCache":false,
  "isByok":false, "tokenHash":"abc12345" }
```
- `tokenHash` = first 8 chars of `sha256(token)`. Correlation without leakage.
- **Never logs** the API key (server or BYOK), request body, or response body.
- Hono `logger()` middleware from Phase 0 is unchanged and continues to log request lines.

## 10. Outbound headers

Every proxied request to Helius carries:
- `X-ThirdEye-Proxy: 1` — analogous to Helius's own reference proxy `X-Helius-Cloudflare-Proxy: true`. Useful for Helius-side debugging.
- `Content-Type: application/json` (POSTs)
- `User-Agent` — Bun's default

The api-key is exclusively in the URL query string (matching Helius's documented usage), never in a header, never logged.

## 11. Testing strategy (decision Q6: full plan, real Helius in CI)

### Tier 1 — Unit (no external services)
- `cache.ts` — key composition is deterministic and order-independent for query params and JSON bodies; LRU eviction; per-entry TTL
- `urls.ts` — REST vs RPC host split, query composition, key placement
- `rpc-policy.ts` — `sendTransaction` / `simulateTransaction` / `requestAirdrop` rejected; valid envelope shape required (jsonrpc, method, params)
- `errors.ts` — status → response shape mapping
- `solana-address.ts` — base58 alphabet + 32–44 char length

### Tier 2 — DB integration (real Postgres, no Helius)
- `rate-limit.ts` — issue token; under `PUBLIC_INSTANCE_MODE=true`, 600 calls succeed and 601st returns 429; window resets after `windowSec`; under `PUBLIC_INSTANCE_MODE=false`, no enforcement; `X-User-Helius-Key` bypasses on `helius_proxy` limit name
- Atomic SQL behavior — concurrent updates don't lose increments

### Tier 3 — Helius integration (real Postgres + real Helius)
Conditional on `process.env.HELIUS_API_KEY`. Each test calls `test.skip(...)` when missing.
- Each of the 7 routes returns 200 + valid-shaped body for the fixture address
- BYOK end-to-end: send a deliberately bad `X-User-Helius-Key` → Helius returns 401 → we pass through 401
- Cache observability: two consecutive identical calls — second has dramatically lower latency, body matches first
- Disallowed RPC method (`sendTransaction`) — middleware returns 403 without any network egress

### Test fixtures
Identified during plan-writing using the `helius` MCP `getWalletFundedBy` tool to pick stable wallets. Pinned in `apps/api/tests/fixtures/helius.ts`:
- One long-dormant wallet with a stable `first_funder` (>1y inactive, verified via MCP)
- One historical confirmed transaction signature
- Static negative cases: `"not-a-real-addr"`, `"11111111111111111111111111111111"` (system program, no funded-by)

## 12. CI changes

`.github/workflows/ci.yml`:
- Add `HELIUS_API_KEY: ${{ secrets.HELIUS_API_KEY }}` to the `env:` block
- Add `PUBLIC_INSTANCE_MODE: "true"` so rate-limit tests can verify enforcement

PRs from forks don't get the secret — Tier-3 tests detect missing key and skip with informative output. Branches in `AIEngineerX/thirdeye` get the full suite.

## 13. Deployment hardening

Application code does the limits + caching. Production deployment of the **public hosted instance** layers additional defense-in-depth (per Helius's "additional security steps" guidance):

- **Helius dashboard:** enable IP allow-list on `HELIUS_API_KEY` so the key only works from the proxy's egress IPs. Compromised secret in CI logs (or anywhere) becomes useless without IP match.
- **Cloudflare in front of `api.thirdeye.app`:** WAF + per-IP rate limit (e.g., 100 req/min/IP). Defense against IP-distributed bots that have rotated through 100s of session tokens.
- **Self-host:** none required. `PUBLIC_INSTANCE_MODE=false` (default) disables app-level limits; protection is whatever firewalls the operator already runs.

These are deployment-time configurations, not code, and not in scope for the Phase 1 PR.

## 14. Spec amendments to parent (`2026-05-01-thirdeye-design.md`)

The same Phase 1 commit also amends parent spec §16:
- Adds the `helius_proxy: 600/hour` limit to the rate-limits list
- Replaces "Helius proxy responses: 5min in-memory LRU" with the two-tier policy (default 5min; 24h for `funded-by`, `getTransaction`, `getBlock`, `getBlockTime`, `getSignatureStatuses`, and the two `transactions-by-sig` POSTs)
- Adds a "Deployment hardening" sub-section pointing at §13 of this Phase 1 spec

## 15. Acceptance criteria

Phase 1 is complete when all of the following hold:

- `bun run lint` exits 0
- `bun run typecheck` exits 0
- `bun run migrate` is a no-op (no schema changes — `rate_bucket` already exists)
- `bun test` — unit + DB tier all pass; Helius tier passes when `HELIUS_API_KEY` set, skips with informative output otherwise
- `docker compose up -d --build` brings up app + postgres
- Manual smoke: with `HELIUS_API_KEY` set, `curl http://localhost:3001/api/helius/v1/wallet/<fixture>/funded-by -H "X-Auth-Token: <token>"` returns the funded-by JSON; without auth header returns 401; with `PUBLIC_INSTANCE_MODE=true` and >600 calls/hour returns 429
- BYOK probe: same call with `X-User-Helius-Key: <bad-key>` returns 401 from Helius (passed through, not 502)
- CORS preflight on `/api/helius/*` returns 204 with `X-Auth-Token` and `X-User-Helius-Key` in `Access-Control-Allow-Headers`
- GitHub Actions CI green on `main` (with `HELIUS_API_KEY` secret configured)
- All commits authored by `AIEngineerX <195990077+AIEngineerX@users.noreply.github.com>`
