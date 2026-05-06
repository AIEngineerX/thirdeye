# Phase 2 — Check Wallet (Design)

Status: approved · Date: 2026-05-04 · Supersedes the bones in `2026-05-01-thirdeye-design.md` §8.1

## Goal

Given a Solana wallet address, return a forensic profile: identity, balances, funding chain (multi-hop), behavioral tags, sibling cluster, numeric risk score, behavioral verdict — streamed as SSE so the user sees pipeline stages light up.

Drives the "Check Wallet" v1 module. Reuses the `/api/helius/*` proxy from Phase 1 — no direct Helius calls outside `@thirdeye/scanner`.

## API

```
GET  /api/wallet/:addr/check               (SSE stream)
POST /api/wallet/check        body { addr } (SSE stream — for clients that prefer POST)
GET  /api/wallet/:addr/last-check          (JSON — cached result, no Helius)
```

Auth: `X-Auth-Token` (anonymous session, Phase 0). BYOK: `X-User-Helius-Key` (Phase 1 — passed through to scanner for extra depth).

`?force=true` query param skips the 24h cache and runs a fresh scan.

### SSE event sequence

```
event: started      data: {addr, mode: "shared"|"byok", cached: false}
event: identity     data: {address, name, type, category}
event: balances     data: {solBalance, usdValue, tokenCount, tokens[]}
event: funding      data: {chain: [{depth, address, funder, fundedAt, sig, isExchange}]}
event: cluster      data: {firstFunder, siblings: [...], timeWindowSiblings: [...], cov: number|null}
event: txPattern    data: {txCount, ageDays, avgGapSec, swapOnly, rapidFire}
event: tags         data: {tags: ["FRESH_WALLET", "BUNDLER", ...]}
event: result       data: {score, verdict, payload: <full WalletCheckResult>}
event: error        data: {error: "...", message: "..."}     (terminal on error path)
```

Cached path: `started` (cached: true) → `result` immediately, no intermediate events.

### `last-check` (cached, JSON)

Returns the most recent `wallet_checks` row's `payload` plus `score`, `verdict`, `checkedAt`. 404 if never checked. No Helius cost.

## Pipeline (server-side, in `@thirdeye/scanner`)

1. **Cache lookup** — `SELECT … FROM wallet_checks WHERE address = $1 ORDER BY checked_at DESC LIMIT 1`. If `now() - checked_at < 24h` and `force !== true`, emit `started` (cached: true) + `result`, done.
2. **Identity** — `GET /v1/wallet/:addr/identity`. Emit `identity`.
3. **Balances** — `GET /v1/wallet/:addr/balances?showNative=true&limit=100`. Emit `balances`.
4. **Funding chain** — recursive `GET /v1/wallet/:addr/funded-by` up to `MAX_HOPS` (3 shared / 5 BYOK), stopping on exchange detection (see §Known addresses). For each hop, also `getTransaction(sig)` to capture `fundedAt` (cached forever — block times immutable). Emit `funding`.
5. **Sibling cluster** — `SELECT address FROM wallets WHERE first_funder = $1` capped at `CLUSTER_LIMIT` (50 shared / 200 BYOK). Then `POST /v1/wallet/batch-identity` to enrich. Compute time-window siblings (those funded within 5 min of target). Compute CoV of recent tx amounts across cluster (best-effort: skip if any sibling has < 5 tx). Emit `cluster`.
6. **Tx pattern** — `GET /v0/addresses/:addr/transactions?limit=100`. Compute `avgGapSec`, `swapOnly`, `rapidFire`. Emit `txPattern`.
7. **Tag computation** — apply rules (§Tags). Emit `tags`.
8. **Score + verdict** — apply formulas (§Score, §Verdict). Emit `result` with full payload.
9. **Persist** — UPSERT `wallets`, INSERT `wallet_checks`, UPSERT `funders.fanout_count`. After SSE close.

Concurrency: each stage in-flight Helius call respects spec §8.2 caps (10/scan, 50/process). The proxy package already enforces upstream rate via Phase 1's middleware; scanner additionally limits its own batch fan-out via a per-scan semaphore (size 10).

## Tags (decoupled from score)

| Tag | Rule |
|---|---|
| `FRESH_WALLET` | `ageDays < 30 AND txCount < 50` |
| `FUND_DISTRIBUTOR` | Outbound SOL to ≥ 20 unique recipients in last 100 tx |
| `BUNDLER` | Sibling cluster size ≥ 3 AND first funder is non-exchange |
| `BUNDLER_TIGHT` | `BUNDLER` AND ≥ 3 siblings funded within 5 min of target |
| `SYBIL` | `BUNDLER` AND CoV of cluster tx amounts < 0.15 (low CoV = coordinated sizing) |
| `SNIPER` | `rapidFire (avgGapSec < 60) AND swapOnly` |
| `WHALE` | `usdValue > 10_000 AND tokenCount ≤ 5` |
| `EXCHANGE` | `firstFunder` matches known exchange OR `identity.type === 'exchange'` |
| `KOL` | Stub for v2 |

A wallet can carry multiple tags. Tags drive both verdict and score.

## Score formula (numeric, 0–100)

```ts
score = clamp(
    (FRESH_WALLET     ? 10 : 0)
  + (FUND_DISTRIBUTOR ? 20 : 0)
  + (BUNDLER          ? 30 : 0)
  + (BUNDLER_TIGHT    ? 10 : 0)        // additive bonus on top of BUNDLER
  + (SYBIL            ? 25 : 0)        // additive bonus
  + (SNIPER           ? 15 : 0)
  - (EXCHANGE         ? 50 : 0)        // exchanges aren't risky to others — collapse to CLEAN
  + min(clusterSize, 50) * 0.5
  - (KOL              ? 10 : 0),
  0, 100
)
```

Magic numbers chosen so a **lone BUNDLER_TIGHT + SYBIL** lands ~70 (HIGH), a **lone FRESH_WALLET** lands 10 (CLEAN), and an **EXCHANGE** always lands 0.

### Score buckets (for UI color, not the verdict label)

`CLEAN` 0–20 · `LOW` 21–45 · `MEDIUM` 46–70 · `HIGH` 71–100.

## Verdict cascade (label, decoupled from score)

First match wins. The label answers "what *kind* of wallet is this?" — orthogonal to the numeric score.

```
EXCHANGE        if EXCHANGE
SYBIL           if SYBIL
BUNDLER         if BUNDLER
SNIPER BOT      if SNIPER
WHALE           if WHALE AND not (BUNDLER OR SNIPER)
FRESH           if FRESH_WALLET AND no other tags
TRADER          if txCount >= 50 AND no risk tags
CLEAN           otherwise
```

So a wallet can be `score: 75` (HIGH) AND `verdict: BUNDLER` — both numbers tell you something. UI surfaces both.

## Known addresses

`packages/shared/src/known-addresses.ts` exports:
- `EXCHANGE_HOT_WALLETS: Set<string>` — Binance, Coinbase, Kraken, OKX, Bybit, Gate.io known deposit/hot wallet addresses (curated list, ~30 addresses, sourced from public block-explorer label DBs — Solscan, Solana FM, Helius identity DB).
- `LAUNCHPAD_FUNDERS: Set<string>` — Pump.fun, Moonshot, LetsBonk fee accounts that fan out funding to launched tokens (these aren't sybil signals — flag separately).
- `CEX_PROGRAM_IDS: Set<string>` — for completeness; not used in Phase 2.

Funding chain stops when next funder hits `EXCHANGE_HOT_WALLETS` or `LAUNCHPAD_FUNDERS` or when depth exceeds `MAX_HOPS`.

## Persistence

`wallet_checks.payload` shape (jsonb):
```ts
{
  identity: HeliusIdentity,
  balances: { solBalance, usdValue, tokenCount, tokens: TokenBalance[] },
  funding: { chain: FundingHop[] },
  cluster: { firstFunder, siblings: SiblingWallet[], timeWindowSiblings: string[], cov: number | null, size: number },
  txPattern: { txCount, ageDays, avgGapSec, swapOnly, rapidFire },
  tags: Tag[],
  mode: "shared" | "byok",
  scannedAt: ISO8601,
}
```

`wallets` row gets UPSERT with: `firstFunder`, `fundedAt`, `solBalance`, `usdValue`, `txCount`, `ageDays`, `tags` (replaces, not appends — checks are authoritative), `lastChecked = now()`.

`funders.fanoutCount` increments on UPSERT for the resolved first funder.

## BYOK gating

| Gate | Shared | BYOK |
|---|---|---|
| `MAX_HOPS` | 3 | 5 |
| `CLUSTER_LIMIT` | 50 | 200 |
| Rate limit (`wallet_check`) | 30/hr/session | bypassed (`bypassOnByok: false` would protect compute, but cluster fanout is the cost — gate is the depth, not the count) |

Code never branches on which key is being used at the call site — `proxyToHelius` already abstracts that. The scanner just consumes a `mode: "shared" | "byok"` flag derived from `Boolean(opts.userKey)` and uses it to pick `MAX_HOPS` and `CLUSTER_LIMIT`.

## Test plan

Unit (`packages/scanner/tests/`):
- Score formula — table-driven, 12 cases covering each tag in isolation and combos.
- Verdict cascade — 8 cases covering each branch.
- Cluster builder — synthetic data, asserts time-window detection and CoV math.
- Funding chain — synthetic Helius responses, asserts stop-on-exchange and depth cap.
- Sniper detector — table-driven on `(avgGapSec, swapOnly)` matrix.

Integration (`apps/api/tests/wallet-check.integration.test.ts`):
- Real Helius (skip-on-no-key) end-to-end on `BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz` (existing fixture). Asserts: SSE event sequence, `result` payload schema, persistence row.
- Cached path: second call within 24h returns `started{cached:true}` + `result` only.
- BYOK path: `X-User-Helius-Key` switches mode to "byok" and respects deeper hop count.

## Out of scope (deferred to v1.1+)

- KOL identity (needs external label source — v2 along with `BadActorsDB`)
- Real-time funder push (would require subscribing to funded-by events — v3 with Helius webhooks)
- Frontend UI (Phase 6 — earlier docs called this Phase 5; Phase 5 is now Alpha Extraction)
- Cross-token serial bundler view (now scoped under Phase 5c — see `2026-05-06-thirdeye-phase-5-alpha-design.md`)

## What we're not copying from godmode

- Pixel-art aesthetic / Press Start 2P. Our UI is sober, dense, Bloomberg-terminal-meets-Linear (Phase 6).
- Storing rendered HTML in the DB (`wallet_checks.result_html` in their schema). We store structured JSON only.
- Client-side heuristic engine. Ours is server-side for SSE, persistence, self-host parity.
- 1-or-2-hop funding chain with no exchange detection. We do 3–5 hops with stop-on-exchange.
- Verdict label coupled to score thresholds. We decouple.
