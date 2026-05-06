# Phase 3 — Scan Token (Design)

Status: draft · Date: 2026-05-05 · Supersedes the bones in `2026-05-01-thirdeye-design.md` §8.2

## Goal

Given a Solana token mint, return a forensic report on its top holders: cluster grouping by first funder, LP/lock supply, supply concentration, SYBIL flag, numeric risk score, and verdict — streamed as SSE so the user sees holders, filters, fan-out progress, and cluster build land in real time.

Drives the "Scan Token" v1 module. Reuses the `/api/helius/*` proxy from Phase 1 (REST + JSON-RPC) and the scanner primitives from Phase 2 (`HeliusClient`, `Tag`, `known-addresses`). New: `Semaphore` primitive (this is when spec §8.2's concurrency caps actually bite — Phase 2 had no fan-out), `programs.ts` LP/lock allowlist, and a token-level risk formula decoupled from wallet-level scoring.

## API

```
GET  /api/token/:mint/scan                   (SSE stream)
POST /api/token/scan       body { mint }     (SSE stream — for clients that prefer POST)
GET  /api/token/:mint/scans/latest           (JSON — cached result, no Helius)
```

Auth: `X-Auth-Token` (anonymous session, Phase 0). BYOK: `X-User-Helius-Key` — passed through to scanner; raises `SCAN_HOLDER_LIMIT` from 200 to 500.

`?force=true` skips the 1h cache and runs a fresh scan.

### SSE event sequence

```
event: started     data: {mint, mode: "shared"|"byok", cached: false}
event: metadata    data: {mint, name, symbol, supply, decimals, launchpad: string|null}
event: holders     data: {totalHolders, scannedHolders, top: [{address, owner, amount, pct}]}
event: lpFilter    data: {lpPct, lockedPct, lpHolders: [{owner, pct, program}], lockedHolders: [...]}
event: fundingProgress  data: {scanned, total, errored}    (single summary after fan-out completes; per-batch streaming is v1.1 — requires generator+queue restructure)
event: clusters    data: {clusters: [{root, members: [...], totalPct, ageRange, ...}]}
event: result      data: {risk, verdict, sybilFlag, payload: <full TokenScanResult>}
event: error       data: {error: "...", message: "..."}    (terminal on error path)
```

Cached path: `started` (cached: true) → `result` immediately, no intermediate events.

### `scans/latest` (cached, JSON)

Returns the most recent `token_scans` row's `payload` plus extracted columns (`riskPct`, `verdict`, `sybilFlag`, `scannedAt`). 404 if never scanned. No Helius cost.

## Pipeline (server-side, in `@thirdeye/scanner`)

1. **Cache lookup** — `SELECT … FROM token_scans WHERE mint = $1 ORDER BY scanned_at DESC LIMIT 1`. If `now() - scanned_at < 1h` and `force !== true`, emit `started` (cached: true) + `result`, done.
2. **Token metadata** — DAS `getAsset(mint)` via JSON-RPC. Extract `name`, `symbol`, `supply`, `decimals`. Detect `launchpad` from creator/authority if it matches a known pump.fun / Moonshot / LetsBonk creator address. Emit `metadata`.
3. **Holders** — Helius `getTokenAccounts({mint, limit: SCAN_HOLDER_LIMIT})` via JSON-RPC, sorted by amount desc. Compute pct of supply per holder. Emit `holders`.
4. **LP/lock filter** — for each holder's `owner`, check against `packages/shared/programs.ts` (LP AMMs + lockers). LP/locked holders are tagged separately and **excluded** from the cluster pass — their supply concentration is structural, not behavioral. Sum `lpPct` and `lockedPct`. Emit `lpFilter`.
5. **Funded-by fan-out** — for each remaining holder's owner address, call `HeliusClient.fundedBy(owner)` bounded by **per-scan Semaphore (size 10)** + **process-wide Semaphore (size 50)** per spec §8.2. Emit `fundingProgress` every ~10 completions for streaming UX. Failed lookups (rate-limit, malformed) record as `null` funder and continue — one bad holder does not kill the scan.
6. **Cluster grouping** — group remaining holders by `funder` (skipping `null` and terminal funders — exchanges and launchpad fee accounts). Each cluster: `{root: funder, members: [holderAddress…], totalPct, ageRange: {oldest, newest}, isFreshFunder: true if root has no prior wallet check OR is tagged FRESH_WALLET}`. Drop singletons (cluster size < 2 — those are unrelated wallets, not coordination).
7. **Cross-ref enrichment** — bulk `SELECT address, tags FROM wallets WHERE address = ANY($1)` for all cluster members. Attach prior tags to each member without spawning new wallet checks (those are user-initiated, not scan-initiated — credit budget).
8. **Risk score + verdict** — apply formula (§Risk). Set `sybilFlag = true` if any single cluster's `totalPct >= 5%`. Emit `result` with full payload.
9. **Persist** — INSERT `token_scans` (extracted columns + full jsonb payload). UPSERT `funders.cluster_count` increment for each cluster root. After SSE close.

Concurrency: per-scan Semaphore (10) bounds funded-by fan-out within a single scan; process-wide Semaphore (50) bounds across all concurrent scans (a single instance shared across requests). Phase 1's helius-proxy rate limit (`HELIUS_PROXY_LIMIT=600/hr`) caps total proxy traffic at the HTTP boundary; the semaphores cap upstream Helius credit burn at the call boundary.

## LP/lock filter (`packages/shared/src/programs.ts`)

Hand-curated `Set<string>` exports for owner addresses we treat as LP-bound or locker-bound:

| Constant | Programs |
|---|---|
| `RAYDIUM_PROGRAMS` | Raydium AMM v4, CLMM, CPMM |
| `METEORA_PROGRAMS` | DLMM, DAMM v1/v2 |
| `ORCA_PROGRAMS` | Whirlpool |
| `JUPITER_PROGRAMS` | Aggregator + Limit Order |
| `LOCKER_PROGRAMS` | Streamflow, Tokenlocker, Goki |

`isLpOrLockOwner(owner) → "lp" | "locked" | null` — single function callers use; returns the category (so we can split `lpPct` from `lockedPct` for the verdict) or `null` for a regular wallet.

Defensive note: LP token accounts are owned **by program-derived addresses (PDAs)**, not by the program ID itself. The cleanest test is `getAccountInfo(owner) → owner.owner === <PROGRAM_ID>`. v1 simplification: match `owner` directly against a small set of known LP **pool authority addresses** (the ~20 most-liquid mint-specific authorities), and accept some false negatives. Full PDA inspection is a v1.1 enhancement.

## Risk formula (numeric, 0–100)

Per spec §8.2:

```ts
risk = clamp(
    totalClusteredPct * 1.0
  + (sybilFlag        ? 25 : 0)
  + (maxClusterPct > 5 ? 15 : 0)
  + (freshFunderCount / Math.max(totalClusters, 1)) * 10,
  0, 100,
)
```

- `totalClusteredPct` — sum of supply % across detected clusters (excludes LP/lock).
- `sybilFlag` — any single cluster's supply % ≥ 5.
- `maxClusterPct` — largest cluster's supply %.
- `freshFunderCount` — clusters whose root has no prior scan OR is `FRESH_WALLET`-tagged.
- `totalClusters` — distinct clusters in the scan.

### Verdict thresholds (token-level)

`CLEAN` 0–10 · `LOW_RISK` 11–35 · `HIGH_RISK` 36–100

Unlike Phase 2's wallet score/verdict split, the token verdict is a single banded label off the risk number. There's no orthogonal "kind of token" axis at v1.

## Persistence

`token_scans.payload` shape (jsonb):

```ts
{
  mint, name, symbol, decimals, supply, launchpad: string | null,
  totalHolders, scannedHolders,
  holders: TopHolder[],                                  // top N with pct
  lp: { totalPct, holders: LpHolder[] },
  locked: { totalPct, holders: LpHolder[] },
  clusters: Cluster[],                                   // size >= 2 only
  totalClusteredPct, maxClusterPct, freshFunderCount,
  risk, sybilFlag, verdict,
  mode: "shared" | "byok",
  scannedAt: ISO8601,
}
```

`token_scans` row gets extracted columns: `mint`, `symbol`, `name`, `launchpad`, `totalHolders`, `scannedHolders`, `clusterCount = clusters.length`, `clusteredPct = totalClusteredPct`, `lpPct`, `lockedPct`, `riskPct = risk`, `sybilFlag`, `verdict`. Indexed on `(mint, scanned_at desc)` (already in schema).

`funders.clusterCount` increments by 1 for each cluster root.

## BYOK gating

| Gate | Shared | BYOK |
|---|---|---|
| `SCAN_HOLDER_LIMIT` | 200 | 500 |
| Rate limit (`scan_token`) | 3/hr/session | bypassed |

Code never branches on which key is being used — `proxyToHelius` already abstracts that. Scanner consumes `mode: "shared" \| "byok"` derived from `Boolean(opts.userKey)` and uses it to pick `SCAN_HOLDER_LIMIT`.

## Test plan

Unit (`packages/scanner/tests/`):

- `semaphore.test.ts` — capacity bounds honored under burst (kick off 50, assert at-most-N concurrent).
- `risk.test.ts` — table-driven, 8 cases covering lone components and clamps.
- `cluster-token.test.ts` (or fold into `cluster.test.ts`) — synthetic holders + funded-by responses, assert grouping skips terminal funders, drops singletons, computes `totalPct` correctly.

Integration (`apps/api/tests/scan-token.integration.test.ts`):

- Real Helius (skip-on-no-key) end-to-end on a stable token mint (default: BONK `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`). Asserts SSE event sequence, `result` payload schema, persistence row.
- Cached path: second call within 1h returns `started{cached:true}` + `result` only.
- Invalid mint returns 400 (no SSE start).
- Missing auth returns 401.
- BYOK path: `X-User-Helius-Key` switches mode to "byok" and respects deeper holder count.

## Known v1 limitation: sampled top-N, not global top-N

Helius DAS `getTokenAccounts` returns indexer-order, not balance-sorted. We sort the returned page by amount desc client-side, but for a popular mint with millions of holders, a single 100-row page is *not* the global top-100 by balance — it's the first 100 indexer-order entries, then ranked among themselves.

This is enough to surface bundler-style coordinated supply concentration (which tends to cluster in the indexer-order sample anyway, since cluster wallets are funded close together in time), but it is **not** a faithful global supply-concentration view for a deeply-distributed token like USDC. The risk score and verdict reflect the sampled picture.

Spec §8.2 promises "top N holders by balance"; we ship "first N from indexer-order, ranked among the sample" with this caveat documented. True global top-N is a v1.1 enhancement, achievable via either (a) cursor-paginating `getTokenAccounts` to the full holder list and sorting all (expensive for popular tokens), or (b) `getTokenLargestAccounts` (Solana RPC, top 20 globally by balance) + `getMultipleAccounts` to deserialize SPL Token account owners. Option (b) is the cheaper path; deferred for v1.

## Out of scope (deferred)

- **Queued worker** (`scan-token` graphile-worker job per spec §13). v1.0 ships inline-SSE for parity with check-wallet; queueing comes when we add the second consumer (Intel auto-rescan, Phase 4+).
- **Full PDA inspection for LP detection** — v1 uses authority-address allowlist with known false negatives; full `getAccountInfo` ownership walk is v1.1.
- **Cross-token serial-bundler view** — querying "this funder shows up across N tokens" needs an index on `funders.cluster_count` + a join view. Phase 4 (Intel).
- **WebSocket scan-progress fanout to other browsers** — Phase 5 (Intel module's live activity panel).
- **Token tags decoupled from clusters** (e.g. `RUG_PULL_HISTORY`, `MUTABLE_AUTHORITY`) — Phase 4+.

## What we're not copying from godmode

- Their token analysis is wallet-centric; ours is supply-distribution-centric. We don't ask "is this token risky?" the way they ask "is this wallet bad?" — we ask "how is the supply concentrated?".
- No on-the-fly LP detection via on-chain authority traversal at v1. Our allowlist is faster, cheaper, and good enough for the headline numbers.
- We persist structured JSON only — no rendered HTML in `payload`.
