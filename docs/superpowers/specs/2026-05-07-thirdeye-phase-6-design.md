# Phase 6 — Personal Alpha Terminal (Hybrid + Agent Brain)

Status: draft (rev2 after multi-axis review) · Date: 2026-05-07 · Builds on Phases 0–5e (v1 backend complete)

## Revision history

**rev2 (2026-05-07)** — addresses findings from five-axis adversarial review (architecture, code-vs-spec drift, cost, scope, frontend taste). Key changes: adds prerequisite sub-phase 6.0 (intel-bus migration to Postgres LISTEN/NOTIFY); reworks cost model with summarization and prompt caching; scopes early-buyers query with explicit caps; corrects route paths and CORS; firms up frontend specifics; adds explicit test strategy and failure-mode sections.

## Goal

Turn ThirdEye into a personal-use Solana alpha terminal that fuses the forensics depth already shipped (Phases 1–5) with three autonomous agent loops and a single dense dashboard frontend.

Phases 1–5 answered "is this wallet/token shady?" and "what is this wallet doing right now?" Phase 6 answers "**which wallets should I be watching, and what just changed?**" without me having to ask.

This spec supersedes the "Phase 6 frontend per original design" reference in the canonical spec at `docs/superpowers/specs/2026-05-01-thirdeye-design.md` line 33 and in `docs/superpowers/specs/2026-05-06-thirdeye-phase-5-alpha-design.md` line 29.

## Reframe from prior planning

The earlier roadmap treated Phase 6 as a Next.js frontend wrapping the Phase 1–5 modules and listed AI Assistant as a v2 deferral. After hands-on review of competitor surface (redacted-competitor in particular), and with the explicit reframe of ThirdEye as a personal tool rather than a marketed launch, three things change:

1. **Hybrid positioning is locked.** Forensics stays the spine. An alpha-tracker layer (watchlist, discovered candidates) sits on top, consuming existing webhook + intel-bus plumbing.
2. **Agent brain is pulled forward.** Three loops (discovery, anomaly detection, on-demand cluster expansion) are part of Phase 6, not deferred.
3. **No marketing surfaces.** No public profile URLs, no leaderboard-for-strangers, no Pro tier, no education funnel. Single-user terminal. Self-host is the default.

What this is **not**: a copy-trade frontend, a price-prediction engine, a TG-channel ingestion product, an auto-trader.

## Where this fits in the roadmap

| Phase | Status |
|---|---|
| 0–5 | shipped |
| **6 Personal Alpha Terminal (this doc)** | draft rev2 |
| 7+ deferrals | unchanged: TG ingest, LaserStream migration, behavior embeddings, CLI surface, multi-provider Helius abstraction |

## 1. Positioning, audience, navigation

### Product framing

ThirdEye is the Solana wallet tracker for one user (the operator), with the forensic depth already shipped as the spine and an LLM-powered agent that finds candidate wallets, narrates watchlist anomalies, and walks the cluster graph on demand.

### Persona

Single user: the operator running their own instance. Public-instance mode (`PUBLIC_INSTANCE_MODE=true`) remains backend-supported and unchanged from Phase 5; the Phase 6 frontend simply does not invest in features that only matter at multi-user scale.

### Navigation (sidebar, six items)

| Item | Purpose | Backed by |
|---|---|---|
| Dashboard | Single dense page: morning brief, watchlist, discovery queue, hot tokens, agent activity | composes endpoints below |
| Watchlist | Full watchlist plus per-wallet drilldown with live trade history and narrated anomalies | `/api/db/watches` (existing), intel-bus, `watch_events` (Phase 5e + new columns) |
| Discovered | Full discovery queue plus filters, history of agent picks, accept/dismiss tracking | new `/api/db/discovered` |
| Intel | Network rollup from Phase 4 (24h pulse, top funders, heatmap) | `/api/db/intel/*` (existing) |
| Agent | Agent run audit, cost trail, daily spend graph | new `/api/db/agent/runs` |
| Settings | BYOK Helius and Anthropic keys with test buttons, daily cost cap, brief schedule, watchlist bulk import | new |

Detail routes outside the sidebar: `/wallet/[addr]` and `/token/[mint]`.

### Out of scope

Stratus-style price-multiplier signal feed, TG/KOL channel ingestion, trade execution, affiliate links, education, Pro tier paywall.

## 2. Data model deltas

Extends `packages/db/src/schema.ts`. Migrations land per sub-phase.

### New: `tokens`

```sql
mint                text PRIMARY KEY
symbol              text
name                text
mc_usd              numeric
price_usd           numeric
mc_24h_pct          numeric
liquidity_usd       numeric
first_seen_at       timestamptz NOT NULL DEFAULT now()
last_refreshed_at   timestamptz NOT NULL DEFAULT now()
```

Cached price/MC for hot tokens. Refreshed by a 60-second worker pulling DexScreener `tokens/v1/solana/<addresses>`. Birdeye and Jupiter are documented escape hatches in code comments only — the v1 implementation ships DexScreener exclusively (see §6 risks).

### New: `discovered_wallets`

```sql
address              text PRIMARY KEY
discovered_at        timestamptz NOT NULL DEFAULT now()
last_rescored_at     timestamptz
score                numeric NOT NULL
source_mints         text[] NOT NULL DEFAULT '{}'
brief                text
status               text NOT NULL DEFAULT 'new'
status_changed_at    timestamptz
```

`status` ∈ {`new`, `reviewed`, `added`, `dismissed`}. Re-discovered wallets update in place (bump `last_rescored_at`, append unique `source_mints`, regenerate `brief`). PK already implies uniqueness on `address` — no separate UNIQUE index. Index on `(status, score DESC)`.

**Deliberate choice — no FK to `wallets(address)`.** The discovery loop encounters wallets that haven't been `checkWallet`-ed yet. Enforcing an FK would require strict write-ordering between two HTTP-driven side effects (worker → API → DB) and turn any partial failure into a constraint violation. Instead, the worker writes to `wallets` and `discovered_wallets` in the same DB transaction within a single function call, dropping the cross-table coupling.

### New: `agent_runs`

```sql
id                bigserial PRIMARY KEY
kind              text NOT NULL                -- discovery|anomaly|cluster_expand|morning_brief
started_at        timestamptz NOT NULL DEFAULT now()
finished_at       timestamptz
status            text NOT NULL                -- see status table below
input             jsonb NOT NULL
output_summary    jsonb
helius_calls      integer NOT NULL DEFAULT 0
llm_tokens_in     integer NOT NULL DEFAULT 0
llm_tokens_out    integer NOT NULL DEFAULT 0
llm_tokens_cached integer NOT NULL DEFAULT 0   -- cached input portion (prompt caching)
cost_usd          numeric NOT NULL DEFAULT 0
error             text
```

**Status taxonomy (single source of truth):**

| Value | Meaning |
|---|---|
| `running` | Run is in flight |
| `success` | Clean completion |
| `failed` | Run errored mid-execution; `error` populated |
| `budget_exceeded` | Per-run cap (tool calls or tokens) tripped during the run |
| `skipped_budget` | Daily cap pre-check failed; run never started |

Index on `(kind, started_at DESC)`, plus index on `started_at` for daily-cap aggregate queries.

### New: `agent_briefs`

```sql
id            bigserial PRIMARY KEY
generated_at  timestamptz NOT NULL DEFAULT now()
kind          text NOT NULL                    -- 'morning' for v1
markdown      text NOT NULL
facts         jsonb NOT NULL
run_id        bigint REFERENCES agent_runs(id)
```

One row per brief. Older briefs retained on a 90-day rolling window (cleanup task in 6k). `facts` captures structured input given to the LLM for replay and audit.

### New: `wallet_baselines`

```sql
address          text PRIMARY KEY
event_count_30d  integer NOT NULL DEFAULT 0
median_swap_sol  numeric                       -- nullable until enough samples
mad_swap_sol     numeric                       -- median absolute deviation, robust to outliers
last_active_at   timestamptz
last_refreshed   timestamptz NOT NULL DEFAULT now()
```

Per-wallet trailing-window stats for the anomaly detector. **Median + MAD instead of mean + sigma** because a single $50k swap permanently contaminates a mean+sigma baseline. Refreshed by a `wallet_baselines_refresh` task on the same 15-min cadence as the anomaly check, materialised so the cron tick reads pre-computed stats. Rules fire only when `event_count_30d >= 50` (cold-start guard).

### Modified: `watch_events`

```sql
ALTER TABLE watch_events ADD COLUMN is_anomaly  boolean NOT NULL DEFAULT false;
ALTER TABLE watch_events ADD COLUMN severity    text;
ALTER TABLE watch_events ADD COLUMN narration   text;
CREATE INDEX watch_events_anomaly_idx ON watch_events(received_at DESC) WHERE is_anomaly = true;
```

Subset of events flagged anomalous, then narrated. Partial index keeps anomaly-feed reads fast.

### Removed from rev1

The `mc_at_scan` column on `token_scans` is dropped from the design. Discovery triggers from the new `tokens` table, not from `token_scans`. The column had no consumer in any endpoint or worker.

### Explicitly not adding

- `cluster_expansions` cache. On-demand for now.
- `agent_chat_history`. Chat investigator was descoped.
- Public profile, leaderboard, social tables.

## 3. API endpoints + agent architecture

### Prerequisite — sub-phase 6.0: intel-bus migration

The current `apps/api/src/lib/intel-bus.ts` is a process-local in-memory `Set<handler>` (lines 1–57). The graphile-worker process and the Hono API process are separate OS processes; events emitted from the worker (where Phase 6 agents run) cannot reach SSE clients attached to the API process.

**6.0 deliverable:** port intel-bus to Postgres LISTEN/NOTIFY.

- `publish(event)` does `pg_notify('intel_bus', $payload)` instead of in-memory dispatch.
- `subscribe(handler)` opens a long-lived `LISTEN intel_bus` connection and dispatches received notifications to local handlers.
- Payload schema: `{kind: string, data: jsonb}`. Postgres `pg_notify` payload limit is 8000 bytes — payloads exceeding that get a `{kind, ref}` shape where `ref` is a row ID in a new `intel_events` overflow table.
- Existing event kinds (`token:scan`, etc.) keep their wire format.

**This is a prerequisite to 6c, 6d, 6e, 6g, 6j.** No agent loop ships before 6.0 lands.

### REST endpoints, all under `X-Auth-Token` auth

**Discovery**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/discovered?status=&limit=` | paginated candidate list |
| POST | `/api/db/discovered/:addr/status` | body `{status}` |
| POST | `/api/db/discovered/run` | trigger discovery loop on demand |

**Agent briefs and runs**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/agent/brief?date=YYYY-MM-DD` | morning brief for date |
| GET | `/api/db/agent/briefs?limit=30` | brief history |
| GET | `/api/db/agent/runs?kind=&limit=` | run audit and cost trail |
| POST | `/api/db/agent/test-key` | minimal Claude API ping for settings UI |

**Cluster expander, on-demand SSE**
| Method | Path | Notes |
|---|---|---|
| POST | `/api/wallet/:addr/expand` | SSE stream emitting `tool_call`, `tool_result`, `brief`, `end` |

Mounted under the existing wallet router prefix (`/api/wallet`), not `/api/db/wallet` — there is no router at the latter. Frontend calls match the actual mount.

**Tokens cache**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/tokens/hot?since=6h&minMcChange=5x&limit=` | source for discovery + dashboard hot-tokens widget |
| GET | `/api/db/tokens/:mint` | single token lookup |

`hot` is registered **before** `:mint` in the router so static-segment matching takes precedence over the dynamic param. Otherwise Hono matches `mint = "hot"` and the static handler never fires.

**CORS allowHeaders update.** `apps/api/src/index.ts:39` adds `X-User-Anthropic-Key` to the allowHeaders list so browser-originated BYOK calls survive CORS preflight. Without this, every Phase 6 endpoint that consults the BYOK header is blocked from the frontend.

**SSE feed.** Existing `/api/db/intel/feed` gains new event kinds: `watch:anomaly`, `discovery:new_candidate`, `discovery:rescored`, `agent:run_started`, `agent:run_finished`. Frontend filters by kind. No new SSE endpoint needed.

### Agent architecture

**Package:** new `packages/agent/`, sibling to `packages/scanner`. Stays env-agnostic; route handlers and worker tasks inject BYOK keys.

**LLM provider:** `@anthropic-ai/sdk`, tool-use loop. BYOK header `X-User-Anthropic-Key` on user-facing endpoints (cluster expander), env `ANTHROPIC_API_KEY` for cron-driven loops. Same pattern as Helius BYOK at `apps/api/src/routes/helius/_lib.ts:48` and `packages/helius/src/proxy.ts:16-17`.

**Models.** Versioned IDs are pinned in `packages/agent/src/models.ts` and verified against the live Anthropic model list before 6b ships:

- Cheap loops (discovery brief, anomaly narration, morning brief): Claude Haiku 4.5 (latest dated revision)
- Cluster expander: Claude Sonnet 4.6 (latest dated revision)
- Both env-overridable via `AGENT_CHEAP_MODEL`, `AGENT_REASONING_MODEL`

**Prompt caching is mandatory.** Tool definitions, system prompt, and any large fixed context (e.g. wallet rubric) are marked `cache_control: {type: "ephemeral"}` in the API call. Cached input is billed at ~10% of the standard input rate. Across the cron loops, this is the largest cost lever and the spec mandates rather than recommends it.

**Wallet payload summarization (mandatory, the second-biggest cost lever).** A `summarizeWalletForLLM(WalletCheckResult): WalletSummary` projection emits at most ~500 tokens per wallet:

```
{
  address, ageDays, txCount, usdValue, tokenCount,
  tags, score, scoreBucket, verdict,
  realizedPnlSol,
  cluster: { firstFunder, size, cov, timeWindowSiblingCount },
  funding: { hops: number, rootIsExchange: boolean },
  topActivity: top 5 tx summaries (type, mint, sol delta)
}
```

Raw `WalletCheckResult` payloads are never fed to the LLM. The summary is what the brief prompt sees. This is the difference between $0.04/run and $1+/run on a 150-buyer discovery loop.

**Tool registry:** wrappers over existing endpoints plus three new ones.

```typescript
// packages/agent/src/tools.ts
export const tools = [
  // Forensic primitives (existing endpoints)
  checkWallet,           // returns WalletSummary, not raw WalletCheckResult
  scanToken,
  getClusterSiblings,
  getFunderClusters,

  // Market primitives
  getHotTokens,          // wraps /api/db/tokens/hot
  getEarlyBuyers,        // see §3.5

  // State primitives
  getWatchlist,
  getDiscoveredQueue,
];
```

Each tool: zod input schema, async handler returning JSON, output token-budgeted (no tool result exceeds ~2k tokens; checkWallet's output is the summary, not the full payload).

**Cost controls, three hard caps, all env-tunable:**

```bash
AGENT_MAX_TOOL_CALLS_PER_RUN=20
AGENT_MAX_INPUT_TOKENS_PER_RUN=200000      # cumulative across loop iterations
AGENT_DAILY_COST_USD_CAP=10
```

**Daily-cap enforcement uses a Postgres advisory lock to prevent races between concurrent cron firings.** Two cron tasks firing at the same instant could both pass an unprotected check. The pattern:

```sql
-- pseudocode in the agent run pre-check
SELECT pg_advisory_xact_lock(hashtext('agent_daily_budget'));
SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs WHERE started_at >= today;
-- if under cap: INSERT new agent_runs row in same tx, COMMIT releases lock
-- if over: INSERT with status='skipped_budget', COMMIT
```

Per-run caps are enforced in-loop (after every Claude response, check `tool_calls_made` and cumulative `input_tokens`).

### Discovery loop, concretely

```
Every hour (cron):
  1. mints = tokens.hot(since=6h, minMcChange=5x, limit=10)
  2. For each mint in mints:
       buyers = getEarlyBuyers(mint)         -- see §3.5 for caps
       For each buyer (capped at first 50):
         if not in wallets:
           result = checkWallet(buyer)       -- side-effect: persist wallets row
           summary = summarizeWalletForLLM(result)
         else:
           summary = readWalletSummary(buyer)
       candidates += score(summary, mint)
  3. Top scorers UPSERT into discovered_wallets (same tx as wallets writes)
  4. LLM (Haiku, prompt-cached) writes brief per new/rescored candidate
  5. NOTIFY intel_bus discovery:new_candidate / discovery:rescored
```

Scoring weights and penalties remain env-tunable (`W_FREQ`, `W_PNL`, `W_TIMING`, `P_BUNDLER`, `P_SYBIL`, `P_FRESH`).

### Anomaly detector, concretely

```
Every 15 min (cron):
  1. For each watched address:
       baseline = wallet_baselines[addr]
       if baseline.event_count_30d < 50: continue        -- cold-start guard
       events_24h = watch_events WHERE addr=$1 AND received_at > now()-24h
       Apply rules to events_24h vs baseline:
         - new token type bought (never held before)            -> medium
         - single-trade SOL outflow > 50% of holdings           -> high
         - >=5 swaps within 15min after >24h dormant            -> high
         - swap size > median + 3*MAD                           -> medium
       For each match:
         narration = LLM(Haiku, prompt-cached) one-line
         UPDATE watch_events SET is_anomaly=true, severity=..., narration=...
         NOTIFY intel_bus watch:anomaly
```

Rule matches are deduplicated per (address, kind, day) so the same dormancy-burst doesn't fire 96 times across a day's checks.

### 3.5 Early-buyers query — explicit scope

The discovery loop's "first ~50 buyers" needs an explicit, capped, dedup-aware definition.

**Strategy:**
1. Use Helius parsed-tx endpoint filtered to the mint, ordered by timestamp ascending where the API supports it. If the API only returns descending, compute time bounds first by querying for the *latest* signature, then time-bound subsequent paginated queries to the first 30 minutes after token's first liquidity event.
2. **Hard caps:**
   - At most 200 signatures fetched per mint (2 pages of 100).
   - Time window: first 30 minutes after the first SWAP/transfer-with-liquidity-program-involved.
3. **Filter pass before deduplication:**
   - Drop signatures where the buyer is a known program PDA, AMM router intermediary, or wrapped-SOL temp account. A small allow-list/deny-list lives in `packages/scanner/src/exchange-list.ts` and gets extended for AMM router programs (Jupiter, Raydium, Orca, Meteora) plus Wrapped SOL ATAs.
   - Drop self-transfers and circular flows.
4. **Dedup:** unique buyers from filtered list, capped at first 50 by ascending timestamp. Returns `[{address, fundedAt}]`.
5. **Documented limitation:** for tokens with >1000 swaps in the first 30 minutes, the first-50-buyers result is *best-effort*. Phase 7 webhook capture (subscribe to mint at first detected liquidity, capture buyers in real time forward) is the long-term fix and is documented as a known limitation, not a TODO in code.

Helius credit budget per mint: ≤ 4 enhanced-tx calls (2 pages + 2 fallback). Across 10 hot mints per discovery run: ≤ 40 calls. The CheckWallet calls that follow on each unique buyer use the existing per-scan semaphore (10 in-flight, 50 per process) — so the discovery loop's *total* Helius credit envelope is `40 + (50 buyers × 15-25 calls each)` ≈ 800-1300 calls per run, not 50. Cost-model section (Appendix A) is rewritten with this realistic number.

### Where agents execute

`graphile-worker` (already wired at `apps/api/src/workers/runner.ts`).

| Task | Schedule | `agent_runs.kind` |
|---|---|---|
| `discovery_run` | hourly cron | `discovery` |
| `anomaly_check` | every 15 min cron | `anomaly` |
| `wallet_baselines_refresh` | every 15 min cron, slightly offset | not an agent run |
| `morning_brief` | daily at user-configured local time | `morning_brief` |
| `cluster_expand` | on-demand, HTTP triggers a worker task | `cluster_expand` |
| `tokens_refresh` | every 60 s | not an agent run |

API process stays light. Agents run in the worker process. Cross-process events flow through the Postgres-backed intel-bus (post 6.0).

## 4. Frontend layout and stack

### Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 App Router, RSC-first |
| Styling | Tailwind CSS v4 with OKLCH color tokens declared in `app/globals.css` `@theme` block |
| Type | Geist (sans), Geist Mono (numbers, addresses, signatures) |
| Components | shadcn/ui, customized — never default radii or palette |
| Charts | Tremor, palette overridden (see below) |
| Icons | `@phosphor-icons/react`, strokeWidth 1.5 globally |
| Motion | Framer Motion: spring (`stiffness: 100, damping: 20`), `layout` and `layoutId` |
| State | TanStack Query (server), Zustand (UI) |
| Streams | EventSource wrapped in isolated `'use client'` leaf, multiplexed via Context |
| Markdown | `react-markdown` + `rehype-highlight` |
| Auth | Anonymous token (existing), BYOK keys in `localStorage` |
| Build | Next 16 standalone, served by Hono via `hono/bun` `serveStatic` adapter |

Tailwind config + `globals.css` enforce OKLCH via `@theme`:
```css
@theme {
  --color-base: oklch(15% 0.005 65);
  --color-surface-1: oklch(18% 0.005 65);
  --color-surface-2: oklch(22% 0.005 65);
  --color-text-1: oklch(95% 0.01 65);
  --color-text-2: oklch(70% 0.01 65);
  --color-accent: oklch(75% 0.18 130);   /* lime, see §4 palette decision */
  --color-warn: oklch(75% 0.18 60);      /* amber for stale-data only */
  --color-danger: oklch(50% 0.18 25);    /* desaturated rose */
}
```

Hex literals (`#xxx`, `#xxxxxx`) and `rgb()` outside `globals.css` `@theme` are forbidden by an ESLint rule (`no-restricted-syntax` selecting `Literal[value=/^#[0-9a-f]{3,8}$/i]`).

### Color strategy: Restrained, off-the-reflex

Reviewer flagged that stone+amber is the 2024-25 VC-crypto warm-dark palette (Phantom, Jito, Tensor) — third-order category reflex. Fix:

- Base remains warm-tinted neutrals (stone-family, OKLCH 15-22% lightness, chroma 0.005)
- **Active/accent: `lime-300` family** (OKLCH 75% / 0.18 / hue 130) — cooler, OKLCH-rich, breaks the warm-dark cliché
- **Amber reserved for one signal: stale data** (e.g. `tokens.last_refreshed_at > 5 min` puts an amber dot on the row). Used nowhere else.
- **Risk: desaturated rose** (`oklch(50% 0.18 25)`) for BUNDLER/SYBIL — deliberately not bright red
- **Positive signal: weight contrast in text-1**, no green for SMART_MONEY (let the data speak; the brief explains)

### Theme: dark, justified

Physical scene: solo trader at a 27-inch display, late night, eyes tired from charts, glances every 15 minutes between Telegram alerts, wants anomalies to surface without scanning. Dark forced by the scene.

### Typography scale (specified)

| Role | Size / line-height | Weight | Notes |
|---|---|---|---|
| Display | 32 / 36 | Geist 500 | morning brief heading, page titles |
| H1 | 20 / 28 | Geist 500 | section labels |
| Body | 13 / 20 | Geist 400 | brief prose, narration |
| Mono | 12 / 18 | Geist Mono 400 | addresses, mints, numbers |
| Micro | 11 / 16 | Geist 500 tracking-wide | column headers, labels |

Max-width 68ch on brief prose only. Tables full-bleed.

### Radii scale (specified)

- `rounded-none` for table rows, list items, dense data containers
- `rounded-sm` (2px) for inputs, badges, small action buttons
- `rounded-lg` (8px) for the Settings page form blocks (the only place generous radii are used)
- No `rounded-xl` or `rounded-2xl` anywhere — those are the SaaS-cream cliché

### Hover, focus, badge patterns

- **Hover:** `bg-surface-1` (solid), never `/50` opacity tints
- **Focus:** `outline-1 outline-accent outline-offset-2`, never `ring-blur` or `ring-2`
- **Badge pattern:** 11px uppercase Geist Mono on `surface-1` background with a 1px left-border in tag-color. No fill tint. Same shape across BUNDLER, SYBIL, SMART_MONEY, CLEAN — only the border color changes.

### Tremor categorical palette

5-stop sequence, declared in chart props:
```
['oklch(95% 0.01 65)',     // text-1 (primary series)
 'oklch(70% 0.01 65)',     // text-2
 'oklch(50% 0.005 65)',    // surface-2 dim
 'oklch(75% 0.18 130)',    // accent (lime)
 'oklch(50% 0.18 25)']     // danger (rose)
```
Categorical only. No gradients. No area fills under 20% opacity. No multi-hue ramps.

### Page tree

```
app/
  layout.tsx                       RSC, sidebar shell, EventSource provider
  page.tsx                         RSC, dashboard, composes server widgets
  watchlist/page.tsx               full watchlist plus drilldown
  discovered/page.tsx              full discovery queue plus filters
  wallet/[addr]/page.tsx           forensic deep dive plus cluster expander button
  token/[mint]/page.tsx            holder, cluster, which-of-yours-hold
  intel/page.tsx                   Phase 4 aggregates
  agent/runs/page.tsx              audit + cost graph
  settings/page.tsx                BYOK keys, budget, brief schedule, bulk watchlist mgmt
  _components/                     (see below)
```

### Dashboard layout, density 7, anti-card

The Morning Brief is **not a card**. It is a full-bleed top section with a heavier hairline below, Display-scale heading, body prose, and inline text-button CTAs (underline-on-hover, no pill chrome). At density 7, focal weight comes from type scale + position + hairline weight, not container chrome.

```
THIRDEYE                     [search]            [Helius] [Anthropic] 23%
═════════════════════════════════════════════════════════════════════════

  MORNING BRIEF, 2026-05-07 06:00

  Your 8 watched wallets did X. 3 candidates surfaced overnight.
  Notable: grimace dumped 80% of WIF at 04:12, anomaly fired.

  Read full   ·   Regenerate

═════════════════════════════════════════════════════════════════════════

  WATCHLIST (8)                  │   DISCOVERY (3 new)
  ─────────────                  │   ─────────────

  cohort1                        │   wallet_xyz                    87.3
  bought POPCAT, 2m              │   Appeared in 4 of last 10 pumps,
  anomaly: 5 swaps in 6m         │   +87k PnL last 30d, no cluster.
                                 │   [SMART_MONEY]
  grimace                        │   Add   Dismiss   Investigate
  sold WIF (-80%), 4h            │
  anomaly: high                  │   wallet_abc                    71.2
                                 │   ...
  view all watchlist             │   view full queue

═════════════════════════════════════════════════════════════════════════

  HOT TOKENS, last 6h, MC ≥ 5x

  ABC    $1.2M    +12.4x    scanned 3h ago    CLEAN       scan
  XYZ    $890k    +8.1x     never             unscanned   scan
  PQR    $640k    +6.3x     scanned 1h ago    CAUTION     view

═════════════════════════════════════════════════════════════════════════

  AGENT ACTIVITY, 24h                        spend $0.31 of $10.00 cap

  06:12   discovery       +3 candidates                $0.04   12 calls
  06:30   anomaly         1 fired                      $0.01    8 calls
  06:00   morning brief   generated                    $0.02    4 calls
```

No em dashes (`—`) in any rendered string. Use comma, period, or middle-dot (`·`) for separators. Lint rule: `no-restricted-syntax` matching `—` literal in JSX/TSX text and template strings outside test fixtures.

### Component inventory

| Component | RSC or Client | Notes |
|---|---|---|
| `MorningBrief.tsx` | RSC | full-bleed top section, no card |
| `HotTokensTable.tsx` | RSC | table, full-bleed |
| `WatchlistRail.client.tsx` | `'use client'` isolated | SSE consumer, Framer `layout` for row inserts |
| `DiscoveryQueue.client.tsx` | `'use client'` isolated | mutation actions |
| `AgentActivityStrip.client.tsx` | `'use client'` isolated | cost meter spring |
| `NarrationLine.client.tsx` | `'use client'` microscopic, memoized | anomaly pulse, isolated re-render |
| `RiskBadges.tsx` | RSC | left-border-only badge pattern |
| `WalletCard.tsx` | RSC | identity + tags + PnL one-liner |
| `ClusterMap.tsx` | RSC | Tremor `BarList` |
| `TradeFeed.client.tsx` | `'use client'` isolated | per-wallet SSE |
| `CostMeter.client.tsx` | `'use client'` microscopic | spring on value change |
| `SettingsForm.client.tsx` | `'use client'` | localStorage + inline test buttons |

Every perpetual animation (anomaly pulse, cost meter spring) lives in its own microscopic memoized client leaf. `app/page.tsx` does not re-render from SSE events.

### Auth and key storage

- Anonymous token in `localStorage` as `te_token`
- BYOK Helius in `localStorage` as `te_helius_key`, sent as `X-User-Helius-Key`
- BYOK Anthropic in `localStorage` as `te_anthropic_key`, sent as `X-User-Anthropic-Key`
- No password, no wallet sign-in, no OAuth

Self-host parity preserved: when env `ANTHROPIC_API_KEY` is set, BYOK is optional. `apps/api/src/index.ts:39` CORS allowHeaders extended with `X-User-Anthropic-Key`.

### Settings page

- BYOK Helius input + Test button (calls `/api/helius/v1/wallet/<sample>/identity`)
- BYOK Anthropic input + Test button (calls `/api/db/agent/test-key`)
- Daily cost cap slider, $1–$50
- Morning brief time + timezone (server-stored)
- Watchlist bulk add/remove (textarea, one address per line)
- Settings export/import (JSON download)

### Component states (designed)

- Empty watchlist: inline onboarding, no modal
- Empty discovery queue: "Discovery loop runs hourly. First run completes around 07:00."
- Loading: skeleton bars matching layout heights, no spinners
- Error: inline under affected section
- Budget exceeded: Agent Activity strip shows "daily cap reached, agent paused until midnight UTC"
- Stale tokens.hot (`last_refreshed_at > 5 min`): amber dot + "data stale" tooltip on hot-tokens table
- DexScreener IP block (consecutive failures): banner above hot-tokens table, "Price source unavailable, last refresh 12 min ago"
- No Helius key: dashboard renders, every action has inline "add Helius key in settings" prompt
- Malformed LLM JSON (brief gen): `agent_briefs.markdown = "(generation failed, run #N — see Agent → Runs)"`, never block the cron

### Motion plan (intensity 6)

- New row enters watchlist: Framer `layout` + spring (stiffness 100, damping 20)
- Anomaly badge: 2-second opacity pulse infinite, isolated leaf
- Cost meter bar: spring on value change
- Discovery candidate Add success: `scale-[0.98]` on active, then row crossfades out
- All animations transform + opacity only

### Build and deploy

- `apps/web/` is new
- Built as Next 16 standalone with API runtime, served by Hono via `hono/bun` `serveStatic` middleware on the same port
- One container in `docker-compose.yml` (`thirdeye-app`), plus existing Postgres
- Dev: `bun run dev` runs Next dev (port 3000) and Hono (port 3001) in parallel; production fuses them on 3001

## 5. Sub-phase rollout (revised estimates)

| # | Sub-phase | Depends on | Estimate | Notes |
|---|---|---|---|---|
| **6.0** | **intel-bus → Postgres LISTEN/NOTIFY migration** | none | **2-3d** | **SHIPPED.** Postgres LISTEN/NOTIFY backed bus, overflow table for >7800-byte payloads. |
| **6a** | **Tokens cache + DexScreener integration + `PriceSource` interface** | none | **3-5d** | **SHIPPED 2026-05-07.** `tokens` table + 0004 migration, `@thirdeye/prices` package, `tokens-refresh` worker on 60s cron, `/api/db/tokens/hot` and `/:mint`, persistScan auto-tracks scanned mints. Birdeye/Jupiter escape-hatches in code comments only. |
| 6b | `packages/agent` + cost controls + Anthropic SDK + prompt caching | 6.0 | **8-11d** | Up from 5-7d. Tool-use loop, BYOK threading through worker tasks (no request-scoped headers), pricing table, token counting across loop iterations, prompt caching wiring, advisory-lock budget gate, integration test harness |
| 6c | Discovery loop (hourly cron + briefs) | 6.0, 6a, 6b | 4-6d | Up from 3-5d. Includes early-buyers query with caps and filter pass |
| 6d | Anomaly detector + `wallet_baselines` materialization | 6.0, 6b | 4-6d | Up from 3-5d. Median+MAD baseline computation, cold-start handling, dedup |
| 6e | Morning brief generator | 6c, 6d | 2-3d | Composes prior loop outputs |
| 6f | `apps/web` Next 16 foundation + layout + auth + EventSource hook | none, parallel with 6.0/6c-e | 3-4d | Geist, shadcn customized, OKLCH tokens, CORS update |
| 6g | Dashboard page (six widgets) | 6c, 6d, 6e, 6f | **7-10d** | Up from 5-7d. SSE consumers + RSC boundaries + Framer choreography + taste compliance review |
| 6h | Wallet + Token detail pages | 6f | 4-5d | Mostly rendering existing endpoints |
| 6i | Settings page (BYOK + budget + schedule) | 6f | 2-3d | |
| 6j | Cluster expander on-demand SSE | 6.0, 6b, 6h | 3-4d | Last agent loop, isolated |
| 6k | Polish, harden, README, docker-compose, integration tests | all | 4-6d | Up from 3-5d. Loading + error states, end-to-end tests |

**Total: 46-66 working days.** Eight to thirteen calendar weeks for solo work, faster if 6f starts in parallel with 6.0/6c-e (frontend builds against stubbed endpoints).

PR strategy: every sub-phase ships as one PR with passing tests. 6.0 is non-skippable; 6a, 6f can start day one.

## 6. Risks (rev2 — promoted from review)

| Risk | Status | Mitigation |
|---|---|---|
| Cost-model error — feeding raw payloads to LLM | **rev2 fix** | `summarizeWalletForLLM()` projection mandated. Prompt caching mandated. Realistic discovery cost recomputed in Appendix A |
| intel-bus is process-local | **rev2 fix** | Sub-phase 6.0 ports to Postgres LISTEN/NOTIFY before any agent loop |
| Helius credit count undercounted | **rev2 fix** | Realistic envelope ~800-1300 calls/discovery run documented in §3.5 + Appendix A |
| Early-buyers query unbounded | **rev2 fix** | §3.5 specifies hard caps (200 sigs/mint, 30-min window), filter pass, dedup, documented degradation on >1k-swap mints |
| Daily $10 cap is operating ceiling, not headroom | **rev2 fix** | Default cap raised to $25 (with summarization + caching, real day is ~$3-5; $25 gives 5x headroom for spikes) |
| LLM cost overrun | active | Per-run cap, daily cap, advisory-lock budget gate, audit trail in `agent_runs` |
| Discovery surfaces low-quality candidates | active | Track add-vs-dismiss ratio, expose in settings, retune scoring weights monthly |
| DexScreener flakiness | active | Stale-data UI badge + banner; fallback escape-hatches documented in code, ship-as-needed |
| Anomaly false-positive flood | active | Median+MAD baseline (rev2), cold-start guard (≥50 events), per-rule firing-rate metric in settings |
| Anthropic rate limits or outages | active | Exponential backoff, mark `agent_runs.status='failed'`, loops degrade gracefully |
| Self-host complexity creep | active | Settings test buttons validate keys before save. Two new env vars: `ANTHROPIC_API_KEY`, `AGENT_DAILY_COST_USD_CAP` |
| Helius dependency cliff | active | Pre-existing; multi-provider abstraction is Phase 7+ scope |

## 7. Test strategy (new in rev2)

CLAUDE.md forbids mocking. Agent runs are non-deterministic and Anthropic-billable. Reconciling these:

### Recorded-trace replay harness

`packages/agent/test/replay.ts` provides a `recordedAnthropicClient(fixturePath)` that returns Anthropic SDK responses from a JSON fixture instead of hitting the API. Fixtures are *real recorded runs* (set `AGENT_RECORD=1 bun test` to capture, then commit the JSON). Replay tests assert:

- Tool dispatch order matches expectation
- Cost computation produces expected `cost_usd` to within 1%
- Token counter matches `usage.input_tokens` + `usage.output_tokens` exactly
- Cap enforcement triggers at the right loop iteration

Replay fixtures are **real Anthropic responses**, just stored on disk. This is not mocking — it's deterministic test playback against captured real behavior. CLAUDE.md compatible.

### Cost fixture table

`packages/agent/test/fixtures/pricing.json` snapshots Anthropic per-token rates per model per date. Test asserts `computeCost(usage, model, date)` returns the documented number for known fixtures. When Anthropic ships new pricing, regenerate the fixture; tests force a code update.

### Advisory-lock budget gate test

A multi-process integration test spawns two worker processes, each fires a cron tick at the same instant. Test asserts: exactly one run is admitted (status `running` → `success`), the other gets `status='skipped_budget'`. Without the lock this race is silent.

### End-to-end discovery test

Against real Postgres, real Helius (skipped without `HELIUS_API_KEY`, per existing convention), recorded Anthropic. Seeds `tokens` with one synthetic hot mint, runs `discovery_run`, asserts at least one `discovered_wallets` row inserted with non-null `brief`.

### Failure-injection tests

- DexScreener returning 429 → tokens worker sets `last_refreshed_at` aged, dashboard shows stale banner
- Helius webhook delivers but `watch_events` insert raises → anomaly cron skips that wallet without false negatives
- LLM returns malformed JSON for brief → `agent_briefs.markdown` falls back to canned string, run still marked `success`

## 8. Success criteria

- Discovery loop surfaces ≥1 wallet per day that gets added to the watchlist
- Anomaly detector fires <5 false positives per day on a 20-wallet watchlist after baseline warmup (30-day window)
- Daily LLM cost <$5 default-config, <$15 heavy-day with summarization + prompt caching active
- Dashboard server-renders <500ms TTFB
- Self-host install: 3 commands (`docker compose up -d`, `bun run migrate`, paste keys in `/settings`)
- Zero LLM-cost surprises (every dollar visible in `agent_runs`)
- intel-bus events round-trip API↔worker correctly under load (verified by 6.0 integration test)

## 9. Deliverables

- Sub-phase 6.0 ships intel-bus migration and is the first PR
- `apps/web/` populated with Next 16 frontend
- `packages/agent/` populated with Claude SDK, tool registry, three cron loops, one on-demand
- New tables: `tokens`, `discovered_wallets`, `agent_briefs`, `agent_runs`, `wallet_baselines`. Modified: `watch_events` (+3 cols)
- Updated `README.md` reflecting Phase 5 shipped state and Phase 6 frontend
- Updated `CLAUDE.md` with agent + Anthropic context
- Updated `docker-compose.yml` with fused app container
- New env vars in `.env.example`: `ANTHROPIC_API_KEY`, `AGENT_DAILY_COST_USD_CAP`, `AGENT_MAX_TOOL_CALLS_PER_RUN`, `AGENT_MAX_INPUT_TOKENS_PER_RUN`, `AGENT_CHEAP_MODEL`, `AGENT_REASONING_MODEL`, `MORNING_BRIEF_HOUR_LOCAL`, `MORNING_BRIEF_TZ`, `DEXSCREENER_BASE_URL`, scoring weights
- Per-sub-phase PRs, each with passing integration tests against real Postgres + real Helius (skipped without key) + recorded Anthropic traces

## 10. Open questions, deferred (not blocking)

1. TG/Twitter signal ingestion as Phase 7+ if Phase 6 succeeds
2. CLI surface (`thirdeye agent investigate <mint>`) post-Phase 6
3. LaserStream gRPC migration for sub-second anomaly latency, Phase 7+
4. Embedding-based wallet similarity, v2 ML work
5. Multi-provider Helius abstraction, Phase 7+ (separate spec)

## Appendix A: Cost model (rev2 — realistic numbers)

**Pricing baseline, May 2026, per Anthropic published rates:**
- Haiku 4.5: $1 / $5 per million tokens (input / output), cached input ~$0.10/M
- Sonnet 4.6: $3 / $15 per million tokens (input / output), cached input ~$0.30/M

**Discovery loop, per run, after summarization + prompt caching:**

| Component | Tokens | Cost |
|---|---|---|
| System prompt + tool defs (cached after first call) | ~2k cached input | ~$0.0002 |
| 50 wallet summaries × 500 tokens | ~25k uncached input | ~$0.025 |
| Brief outputs (~150 tokens × 5 candidates) | ~750 output | ~$0.004 |
| **Per-run total** | | **~$0.03–0.05** |

24 runs/day → ~$0.72–1.20 LLM cost.

**Without summarization + caching (the rev1 mistake):** raw `WalletCheckResult` payloads at 3-8k tokens × 50 wallets = 150-400k input tokens × Haiku $1/M = $0.15-0.40 LLM input alone, plus output, plus uncached repeated tool defs. ~$1+/run, ~$24+/day. The rev2 mandate of summarization and caching is the difference.

**Anomaly detector, per firing:** ~2k input + ~100 output, Haiku, prompt-cached → ~$0.003. Realistic 10 firings/day → ~$0.03/day.

**Cluster expander, per call (Sonnet, on-demand):** 8-15 turn loop, each turn re-feeds prior tool outputs. Without caching: ~$0.30-0.60. **With caching of the system prompt + tool defs (mandated):** ~$0.10-0.25. Heavy use (10/day) ≈ $1-2.50/day.

**Morning brief, per day:** ~5k input cached + ~500 output, Haiku → ~$0.005.

**Daily totals at default config:**
- Light day (no cluster expansions): ~$0.75-1.25
- Default day (3 cluster expansions): ~$1-2
- Heavy day (10 cluster expansions): ~$2-4

**Daily cap default raised from $10 to $25** to give 5x-10x headroom over realistic operation. Cap remains a safety net, not the operating ceiling.

**Helius credit envelope per discovery run:**
- ~40 enhanced-tx for early-buyers across 10 hot mints
- ~50 buyers × 15-25 calls each (CheckWallet pipeline) = 750-1250 calls
- Total: 800-1300 enhanced-tx per discovery run
- 24 runs/day → ~20k-30k enhanced-tx/day, well within Helius paid-tier monthly allotments (~5M credits) but worth monitoring on the dashboard

## Appendix B: Env var reference (additions)

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
AGENT_CHEAP_MODEL=claude-haiku-4-5-<dated>
AGENT_REASONING_MODEL=claude-sonnet-4-6-<dated>

# Agent budget
AGENT_DAILY_COST_USD_CAP=25
AGENT_MAX_TOOL_CALLS_PER_RUN=20
AGENT_MAX_INPUT_TOKENS_PER_RUN=200000

# Morning brief schedule
MORNING_BRIEF_HOUR_LOCAL=6
MORNING_BRIEF_TZ=America/New_York

# Price data
DEXSCREENER_BASE_URL=https://api.dexscreener.com

# Discovery scoring weights
W_FREQ=10
W_PNL=0.5
W_TIMING=2
P_BUNDLER=20
P_SYBIL=30
P_FRESH=10
```

## Appendix C: Notes for future phases

- 6.0's intel-bus migration becomes the substrate for any future cross-process event work (e.g. multi-instance federation, deferred to v3).
- Phase 6 establishes the agent infrastructure. Adding new agent loops in Phase 7+ becomes incremental.
- The `agent_runs` audit trail makes scoring-weight experiments measurable.
- The recorded-trace replay harness from §7 should be reused for any future agent loops.
- Anti-card density and OKLCH-only color tokens are Phase 6 design constraints worth maintaining across future phases.
