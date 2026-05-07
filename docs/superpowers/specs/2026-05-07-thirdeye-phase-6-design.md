# Phase 6 — Personal Alpha Terminal (Hybrid + Agent Brain)

Status: draft · Date: 2026-05-07 · Builds on Phases 0–5e (v1 backend complete)

## Goal

Turn ThirdEye into a personal-use Solana alpha terminal that fuses the forensics depth already shipped (Phases 1–5) with three autonomous agent loops and a single dense dashboard frontend.

Phases 1–5 answered "is this wallet/token shady?" and "what is this wallet doing right now?" Phase 6 answers "**which wallets should I be watching, and what just changed?**" without me having to ask.

This spec supersedes the "Phase 6 frontend per original design" reference in the canonical spec at `docs/superpowers/specs/2026-05-01-thirdeye-design.md` line 33 and in `docs/superpowers/specs/2026-05-06-thirdeye-phase-5-alpha-design.md` line 29.

## Reframe from prior planning

The earlier roadmap treated Phase 6 as a Next.js frontend wrapping the Phase 1–5 modules (Check Wallet, Scan Token, Intel Analytics) and listed AI Assistant as a v2 deferral. After hands-on review of competitor surface (ocula.fun in particular), and with the explicit reframe of ThirdEye as a personal tool rather than a marketed launch, three things change:

1. **Hybrid positioning is locked.** Forensics stays the spine. An alpha-tracker layer (watchlist, discovered candidates, leaderboard-as-data) sits on top, consuming the existing webhook + intel-bus plumbing from Phase 5e.
2. **Agent brain is pulled forward.** Three loops (discovery, anomaly detection, on-demand cluster expansion) are part of Phase 6, not deferred. They are the differentiator, not a polish item.
3. **No marketing surfaces.** No public profile URLs, no leaderboard-for-strangers, no Pro tier, no education funnel. Single-user terminal. Self-host is the default.

What this is **not**: a copy-trade frontend, a price-prediction engine, a TG-channel ingestion product, an auto-trader. The agent surfaces wallets and narrates events; humans decide.

## Where this fits in the roadmap

| Phase | Status |
|---|---|
| 0 Foundation | shipped |
| 1 Helius proxy | shipped |
| 2 Check Wallet | shipped |
| 3 Scan Token | shipped |
| 4 Intel Analytics | shipped |
| 5 Alpha Extraction (5a–5e) | shipped |
| **6 Personal Alpha Terminal (this doc)** | draft |
| 7+ deferrals (TG ingest, LaserStream migration, behavior embeddings, CLI surface) | unchanged |

## 1. Positioning, audience, navigation

### Product framing

ThirdEye is the Solana wallet tracker for one user (you), with the forensic depth you already shipped as the spine and an LLM-powered agent that finds candidate wallets, narrates watchlist anomalies, and walks the cluster graph on demand.

### Personas, single-user

There is exactly one user: the operator running their own instance. All design decisions optimise for that user reading the dashboard fifteen minutes at a time, multiple times a day.

Public-instance mode (`PUBLIC_INSTANCE_MODE=true`) remains supported by the backend and is unchanged from Phase 5. The Phase 6 frontend simply does not invest in features that only matter at multi-user scale (signup flows, public profile pages, leaderboards-for-strangers, paywall tiers).

### Navigation (sidebar, six items)

| Item | Purpose | Backed by |
|---|---|---|
| Dashboard | Single dense page: morning brief, watchlist, discovery queue, hot tokens, agent activity | composes endpoints below |
| Watchlist | Full watchlist plus per-wallet drilldown with live trade history and narrated anomalies | `/api/db/watches` (existing), `intel-bus` (existing), `watch_events` (Phase 5e + new columns) |
| Discovered | Full discovery queue plus filters, history of agent picks, accept/dismiss tracking | new `/api/db/discovered` |
| Intel | Network rollup from Phase 4 (24h pulse, top funders, heatmap) | `/api/db/intel/*` (existing) |
| Agent | Agent run audit, cost trail, daily spend graph | new `/api/db/agent/runs` |
| Settings | BYOK Helius and Anthropic keys with test buttons, daily cost cap, brief schedule, watchlist bulk import | new |

Detail routes outside the sidebar: `/wallet/[addr]` and `/token/[mint]`.

### Explicitly out of scope

- Stratus-style price-multiplier signal feed (would need a price-action ranking pipeline ThirdEye does not have, and pretending to predict pumps violates the no-snake-oil principle)
- TG Calls / KOL channel ingestion
- Trade execution and affiliate links
- Education or courses
- Pro tier paywall (BYOK is the only rate-bypass mechanism)

## 2. Data model deltas

Extends `packages/db/src/schema.ts`. Migrations land per sub-phase, not in one drop.

### New: `tokens`

```
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

Cached price and market-cap state for hot tokens. Refreshed by a 60-second worker pulling DexScreener `tokens/v1/solana/<addresses>` (no auth, generous rate). Birdeye and Jupiter price endpoints are documented fallbacks if DexScreener becomes restricted.

### New: `discovered_wallets`

```
address              text PRIMARY KEY        REFERENCES wallets(address)
discovered_at        timestamptz NOT NULL DEFAULT now()
last_rescored_at     timestamptz
score                numeric NOT NULL
source_mints         text[] NOT NULL DEFAULT '{}'
brief                text
status               text NOT NULL DEFAULT 'new'
status_changed_at    timestamptz
```

`status` is one of `new`, `reviewed`, `added`, `dismissed`. Re-discovered wallets update the row in place: bump `last_rescored_at`, append unique `source_mints`, regenerate `brief`. UNIQUE on address. Index on `(status, score DESC)`.

### New: `agent_runs`

```
id                bigserial PRIMARY KEY
kind              text NOT NULL
started_at        timestamptz NOT NULL DEFAULT now()
finished_at       timestamptz
status            text NOT NULL          -- running|success|failed|skipped_budget|budget_exceeded
input             jsonb NOT NULL
output_summary    jsonb
helius_calls      integer NOT NULL DEFAULT 0
llm_tokens_in     integer NOT NULL DEFAULT 0
llm_tokens_out    integer NOT NULL DEFAULT 0
cost_usd          numeric NOT NULL DEFAULT 0
error             text
```

`kind` is one of `discovery`, `anomaly`, `cluster_expand`, `morning_brief`. Index on `(kind, started_at DESC)`. Index on `started_at` (for daily-cap aggregate).

### New: `agent_briefs`

```
id            bigserial PRIMARY KEY
generated_at  timestamptz NOT NULL DEFAULT now()
kind          text NOT NULL              -- 'morning' for v1
markdown      text NOT NULL
facts         jsonb NOT NULL
run_id        bigint REFERENCES agent_runs(id)
```

One row per brief. Older briefs retained on a 90-day rolling window (cleanup task in 6k). `facts` captures structured input given to the LLM for replay and audit.

### Modified: `watch_events`

```
ALTER TABLE watch_events ADD COLUMN is_anomaly  boolean NOT NULL DEFAULT false;
ALTER TABLE watch_events ADD COLUMN severity    text;
ALTER TABLE watch_events ADD COLUMN narration   text;
CREATE INDEX watch_events_anomaly_idx ON watch_events(received_at DESC) WHERE is_anomaly = true;
```

Subset of events flagged anomalous by the rule engine, then narrated by the LLM. Partial index keeps anomaly-feed reads fast without a separate table.

### Modified: `token_scans`

```
ALTER TABLE token_scans ADD COLUMN mc_at_scan numeric;
```

Lets the discovery loop trigger on MC change between scans without re-querying external price APIs.

### Explicitly not adding

- `cluster_expansions` cache. On-demand for now. Add only if redundant calls become measurably costly.
- `agent_chat_history`. Chat investigator was descoped in scope-question.
- Public profile, leaderboard, social tables. Personal tool.

## 3. API endpoints + agent architecture

### REST endpoints, all under existing `X-Auth-Token` auth model

**Discovery**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/discovered?status=&limit=` | paginated candidate list |
| POST | `/api/db/discovered/:addr/status` | body `{status}`, promote to watchlist or dismiss |
| POST | `/api/db/discovered/run` | trigger discovery loop on demand (cron also runs hourly) |

**Agent briefs and runs**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/agent/brief?date=YYYY-MM-DD` | morning brief for date, default today |
| GET | `/api/db/agent/briefs?limit=30` | brief history |
| GET | `/api/db/agent/runs?kind=&limit=` | run audit and cost trail |
| POST | `/api/db/agent/test-key` | minimal Claude API ping for settings UI to validate BYOK Anthropic key |

**Cluster expander, on-demand SSE**
| Method | Path | Notes |
|---|---|---|
| POST | `/api/db/wallet/:addr/expand` | SSE stream emitting `tool_call`, `tool_result`, `brief`, `end` events as the agent investigates |

**Tokens cache**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/db/tokens/:mint` | single |
| GET | `/api/db/tokens/hot?since=6h&minMcChange=5x&limit=` | source for discovery trigger and dashboard hot-tokens widget |

**Anomalies feed**

The existing `/api/db/intel/feed` SSE gains new event kinds: `watch:anomaly`, `discovery:new_candidate`, `discovery:rescored`, `agent:run_started`, `agent:run_finished`. Frontend filters by kind. No new SSE endpoint needed.

### Agent architecture

**Package layout:** new `packages/agent/`, sibling to `packages/scanner`. Stays env-agnostic; route handlers and worker tasks inject BYOK keys.

**LLM provider:** `@anthropic-ai/sdk`, tool-use loop. BYOK header `X-User-Anthropic-Key` on user-facing endpoints (cluster expander), env `ANTHROPIC_API_KEY` for cron-driven loops. Same pattern as Helius BYOK.

**Models, picked deliberately:**

- Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) for discovery briefs, anomaly narrations, morning brief. Cheap, fast, summarisation-grade.
- Claude Sonnet 4.6 (`claude-sonnet-4-6`) for cluster expander. Multi-hop reasoning across graph data.

Both env-overridable. Opus is not the default for any of these; diminishing returns vs cost.

**Tool registry:** the agent's tools are wrappers over endpoints already shipped, plus three new ones.

```typescript
// packages/agent/src/tools.ts
export const tools = [
  // Forensic primitives (existing endpoints)
  checkWallet,
  scanToken,
  getClusterSiblings,
  getFunderClusters,

  // Market primitives
  getHotTokens,        // wraps /api/db/tokens/hot
  getEarlyBuyers,      // new, Helius parsed-tx query sorted ascending by ts

  // State primitives
  getWatchlist,
  getDiscoveredQueue,
];
```

Each tool: zod input schema, async handler, returns JSON. The agent loop is: call Claude, if `tool_use` execute handler, feed result back, repeat until `end_turn` or budget cap.

**Cost controls, three hard caps, all env-tunable:**

```bash
AGENT_MAX_TOOL_CALLS_PER_RUN=20
AGENT_MAX_INPUT_TOKENS_PER_RUN=200000
AGENT_DAILY_COST_USD_CAP=10
```

Enforcement:
- Per-run cap: agent loop checks `tool_calls_made` and `total_input_tokens` after every Claude response, aborts with `status='budget_exceeded'` if exceeded.
- Daily cap: before scheduling any cron run, query `SUM(cost_usd) WHERE started_at >= today`. Skip the run if cap reached, log `status='skipped_budget'`.
- Helius semaphore: existing 10-in-flight cap from Phase 1 reused. No new concurrency primitive.

**Cost computation:** every Claude response carries `usage.input_tokens` and `usage.output_tokens`. Multiply by per-model token prices in `packages/agent/src/pricing.ts` (lookup table updated when Anthropic ships new tiers). Helius credits computed from the existing tool-routing table.

**Where agents execute:** `graphile-worker` (already in stack, no new infra).

| Task | Schedule | `agent_runs.kind` |
|---|---|---|
| `discovery_run` | hourly cron | `discovery` |
| `anomaly_check` | every 15 min cron | `anomaly` |
| `morning_brief` | daily at user-configured local time | `morning_brief` |
| `cluster_expand` | on-demand, HTTP triggers a worker task | `cluster_expand` |
| `tokens_refresh` | every 60 s | not an agent run, just data refresh |

API process stays light. Agents run in the worker process. SSE clients listen via intel-bus, which both processes publish to over Postgres LISTEN/NOTIFY (existing infra from Phase 4).

### Discovery loop, concretely

```
Every hour (cron):
  1. tokens.hot(since=6h, minMcChange=5x) -> mint list
  2. For each pumped mint:
       early_buyers = getEarlyBuyers(mint, 50)
       for buyer not in wallets: checkWallet(buyer)
  3. Score each candidate:
       score = (cross_token_count * W_FREQ)
             + (realized_pnl_sol * W_PNL)
             + (early_entry_rank_avg * W_TIMING)
             - (BUNDLER ? P_BUNDLER : 0)
             - (SYBIL ? P_SYBIL : 0)
             - (FRESH_WALLET ? P_FRESH : 0)
  4. Top scorers upserted into discovered_wallets
  5. LLM (Haiku) writes one paragraph per new or rescored candidate
  6. Emit discovery:new_candidate / discovery:rescored on intel-bus
```

All scoring weights and penalties are env vars (`W_FREQ`, `W_PNL`, `W_TIMING`, `P_BUNDLER`, `P_SYBIL`, `P_FRESH`), enabling live experimentation without code changes.

### Anomaly detector, concretely

```
Every 15 min (cron):
  For each watched address:
    Pull last 24h of events from watch_events.
    Compare to trailing 30d baseline:
      - new token type bought (never held before)              -> medium
      - single-trade SOL outflow > 50% of holdings             -> high
      - burst of >5 swaps within 15min after >24h dormant      -> high
      - average swap size > 3 sigma above historical           -> medium
    For each match:
      LLM (Haiku) writes one-line narration.
      UPDATE watch_events SET is_anomaly=true, severity=..., narration=...
      Emit watch:anomaly on intel-bus.
```

Rule-based filters first, LLM only narrates. Bounded LLM cost; most events do not trigger.

### Early-buyers query (the one real unknown from Section 2)

`packages/scanner/src/scan-token.ts` returns top *current* holders, not first buyers. The discovery loop wants the first ~50 wallets to acquire each token.

Two options:
1. Helius parsed transactions for the mint, filter to SWAP and TRANSFER events, sort by timestamp ascending, take first N unique buyers. Works retroactively. ~1 enhanced-tx call per scan, plus pagination if needed.
2. Helius webhook on the mint as soon as it crosses a watch threshold. Captures buyers in real time. Forward-only.

Phase 6 ships option 1 (works on tokens that already pumped). Option 2 lands as a Phase 7 optimisation for new mints we are tracking from launch.

## 4. Frontend layout and stack

### Stack, taste-skills compliant

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 App Router, RSC-first | per existing spec |
| Styling | Tailwind CSS v4 | stack standard |
| Type | Geist (sans), Geist Mono (numbers, addresses, signatures) | Inter is banned for technical UI |
| Components | shadcn/ui customised (rounded-2xl base, stone palette overrides) | never default state |
| Charts | Tremor, palette overridden to stone + amber | best React chart lib for dashboards |
| Icons | `@phosphor-icons/react`, strokeWidth 1.5 globally | no emojis, no lucide |
| Motion | Framer Motion: spring (stiffness 100, damping 20), `layout` and `layoutId` for row inserts | no linear, no bounce |
| State | TanStack Query (server), Zustand (UI) | mature, lean |
| Streams | EventSource wrapped in isolated `'use client'` leaf component | one connection per page, multiplexed via Context |
| Markdown | `react-markdown` + `rehype-highlight` | brief rendering |
| Auth | Anonymous token (existing), BYOK keys in `localStorage` | no wallet sign-in for v1 |
| Build | Next 16 standalone export served by Hono backend | one container instead of two |

### Color strategy: Restrained

Tinted neutrals plus one accent under 10 percent of surface.

- Base `stone-950` (warm off-black, never `#000`)
- Surface tiers `stone-950` to `stone-900` to `stone-800` for elevation without shadows
- Text `stone-100` body (off-cream, never `#fff`), `stone-400` muted, `stone-500` deep-muted
- Accent `amber-400` for active state, regenerate buttons, "new" badges
- Risk `rose-700` for BUNDLER, SYBIL, desaturated, not alarmist
- Positive: weight contrast in `stone-100`, no green
- Borders `stone-800/60`, hairlines, never colored stripes

### Theme: dark, justified

Physical scene that forces it: solo trader at a 27-inch display, late night, eyes tired from charts, glances every fifteen minutes between Telegram alerts, wants anomalies to surface without scanning. Dark forced. Warm-stone palette sidesteps both the "neon-on-black" first reflex and the "terminal-green" second reflex.

### Page tree

```
app/
  layout.tsx                       RSC, sidebar shell, EventSource provider
  page.tsx                         RSC, dashboard, composes server widgets
  watchlist/page.tsx               full watchlist plus drilldown
  discovered/page.tsx              full discovery queue plus filters and history
  wallet/[addr]/page.tsx           forensic deep dive plus cluster expander button
  token/[mint]/page.tsx            holder, cluster, which-of-yours-hold
  intel/page.tsx                   Phase 4 aggregates
  agent/runs/page.tsx              audit and cost graph
  settings/page.tsx                BYOK keys, budget, brief schedule, bulk watchlist mgmt
  _components/
    MorningBrief.tsx                 RSC
    HotTokensTable.tsx               RSC
    WatchlistRail.client.tsx         'use client' isolated, SSE consumer, Framer layout
    DiscoveryQueue.client.tsx        'use client' isolated, mutation actions
    AgentActivityStrip.client.tsx    'use client' isolated, cost meter spring
    NarrationLine.client.tsx         'use client' microscopic, anomaly pulse
    RiskBadges.tsx                   RSC, tag pill renderer
    WalletCard.tsx                   RSC, identity plus tags plus PnL one-liner
    ClusterMap.tsx                   RSC, Tremor BarList or DonutChart
    TradeFeed.client.tsx             'use client' isolated, per-wallet SSE
    CostMeter.client.tsx             'use client' microscopic, spring on value change
    SettingsForm.client.tsx          'use client', localStorage plus inline test buttons
```

Every perpetual animation lives in its own microscopic memoized client leaf. `app/page.tsx` does not re-render from SSE events.

### Dashboard layout, density 7, anti-card

```
THIRDEYE                     [search]            [Helius] [Anthropic] 23%
────────────────────────────────────────────────────────────────────────────

  MORNING BRIEF · 2026-05-07 · 06:00

  Your 8 watched wallets did X. 3 candidates surfaced overnight.
  Notable: grimace dumped 80% of WIF at 04:12, anomaly fired.

  [Read full]   [Regenerate]

────────────────────────────────────────────────────────────────────────────

  WATCHLIST (8)                  │   DISCOVERY (3 new)
  ─────────────                  │   ─────────────

  cohort1                        │   wallet_xyz       87.3
  bought POPCAT, 2m              │   Appeared in 4 of last 10 pumps,
  anomaly: 5 swaps in 6m         │   +87k PnL last 30d, no cluster.
                                 │   [SMART_MONEY]
  grimace                        │   [Add]  [Dismiss]  [Investigate]
  sold WIF (-80%), 4h            │
  anomaly: high                  │   wallet_abc       71.2
                                 │   ...
  view all watchlist             │   view full queue

────────────────────────────────────────────────────────────────────────────

  HOT TOKENS · last 6h · MC ≥ 5x

  ABC    $1.2M    +12.4x    scanned 3h ago    CLEAN       scan
  XYZ    $890k    +8.1x     never             unscanned   scan
  PQR    $640k    +6.3x     scanned 1h ago    CAUTION     view

────────────────────────────────────────────────────────────────────────────

  AGENT ACTIVITY · 24h                          spend $0.31 / cap $10.00

  06:12   discovery       +3 candidates                $0.04   12 calls
  06:30   anomaly         1 fired                      $0.01    8 calls
  06:00   morning brief   generated                    $0.02    4 calls
```

Single page, density 7. Vertical hairlines instead of card chrome. The Morning Brief is the one card because elevation is functional: it is the daily focal point with primary CTAs.

### Auth and key storage

- Anonymous token issued on first visit, stored in `localStorage` as `te_token`
- BYOK Helius key in `localStorage` as `te_helius_key`, sent as `X-User-Helius-Key`
- BYOK Anthropic key in `localStorage` as `te_anthropic_key`, sent as `X-User-Anthropic-Key`
- No password, no wallet sign-in, no OAuth

Self-host parity: when env `ANTHROPIC_API_KEY` is set on the server, BYOK is optional. Server falls back to its own key. Matches existing Helius BYOK pattern. This preserves public-instance mode if `PUBLIC_INSTANCE_MODE=true` is ever flipped.

### Settings page

- BYOK Helius input plus Test button (calls `/api/helius/v1/wallet/<sample-addr>/identity`, shows result)
- BYOK Anthropic input plus Test button (calls `/api/db/agent/test-key`, minimal Claude ping)
- Daily cost cap slider, $1 to $50
- Morning brief time and timezone (server-stored, needed for cron)
- Watchlist bulk add and remove (textarea, one address per line)
- Settings export and import (JSON download)

### Component states (designed, not happy-path-only)

- Empty watchlist: inline onboarding, "Paste a wallet address to start watching." Not a modal.
- Empty discovery queue: "Discovery loop runs hourly. First run completes around 07:00."
- Loading: skeleton bars matched to layout heights. No circular spinners.
- Error: inline under affected section, e.g. "Helius rate-limited, retrying in 30s." No global toast.
- Budget exceeded: Agent Activity strip shows "daily cap reached, agent paused until midnight UTC", muted not alarmist.
- No Helius key: dashboard renders, every action has inline "add Helius key in settings" prompt, no blocking modal.

### Motion plan, intensity 6

- New row enters watchlist: Framer `layout` plus spring (stiffness 100, damping 20)
- Anomaly badge: 2-second opacity pulse infinite, isolated leaf
- Cost meter bar: spring on value change, never linear
- Discovery candidate Add button success: `scale-[0.98]` on active, then row crossfades out
- All animations transform plus opacity only. No width, height, top, left.

### Build and deploy

- `apps/web/` is new
- Built as Next 16 standalone with API runtime, served by Hono via `serveStatic` middleware on the same port
- One container in `docker-compose.yml` named `thirdeye-app`, plus the existing Postgres container
- Dev: `bun run dev` runs Next dev server on port 3000 and Hono on 3001 in parallel; production fuses them on 3001

## 5. Sub-phase rollout

| # | Sub-phase | Depends on | Estimate | Notes |
|---|---|---|---|---|
| 6a | Tokens cache plus DexScreener integration | none | 3-5d | Foundation for 6c. Cron, new tables, no UI |
| 6b | `packages/agent` plus cost controls plus Anthropic SDK | none | 5-7d | Foundation for 6c, 6d, 6e, 6j. Tool registry, BYOK pattern |
| 6c | Discovery loop, hourly cron plus briefs | 6a, 6b | 3-5d | Headline backend feature |
| 6d | Anomaly detector on `watch_events` | 6b | 3-5d | Reuses existing webhook plus intel-bus |
| 6e | Morning brief generator | 6c, 6d | 2-3d | Composes outputs of prior loops |
| 6f | `apps/web` Next 16 foundation, layout, auth | none, parallel with 6c-e | 3-4d | Geist, shadcn customised, EventSource hook |
| 6g | Dashboard page, six widgets | 6c, 6d, 6e, 6f | 5-7d | Headline UI |
| 6h | Wallet plus token detail pages | 6f | 4-5d | Mostly rendering existing endpoints |
| 6i | Settings page, BYOK plus budget plus schedule | 6f | 2-3d | |
| 6j | Cluster expander on-demand SSE | 6b, 6h | 3-4d | Last agent loop, isolated |
| 6k | Polish, harden, README, docker-compose | all | 3-5d | Loading and error states, integration tests, README to current state |

Total 36-53 working days, six to ten calendar weeks for solo work, faster if 6f starts in parallel with 6c-e (frontend builds against stubbed endpoints).

PR strategy: every sub-phase ships as one PR with passing tests. Long-lived branches discouraged. 6a, 6b, 6f can start day one in parallel.

## 6. Risks, ranked by likelihood times impact

| Risk | Mitigation |
|---|---|
| LLM cost overrun | Per-run cap, daily cap, Haiku for cheap ops, audit trail in `agent_runs` so spikes are debuggable |
| Discovery surfaces low-quality candidates | Track add-vs-dismiss ratio per source token type, expose in settings, retune scoring weights monthly. Score formula is env-tunable for live experimentation |
| DexScreener API flakiness or rate limits | Two fallbacks: Birdeye API and Jupiter price endpoint. `tokens.last_refreshed_at` lets stale data still serve, with a UI badge |
| Discovery loop misses sub-hour pumps | Hourly is the default. `/api/db/discovered/run` is on-demand. Add UI "rescan hot tokens now" button on dashboard |
| Helius credit spike on discovery | Existing per-scan semaphore (10 in-flight, 50 per process) bounds. Discovery adds at most ~50 enhanced-tx calls per hour |
| Anomaly detector false positive flood | Rule-based filters first, LLM only narrates. Per-rule firing-rate metric in settings; surface "this rule fired 47 times today" to enable tuning |
| Anthropic API rate limits or outages | Exponential backoff, mark `agent_runs.status='failed'` cleanly, dashboard shows agent health. Loops degrade gracefully (data still flows, no narration) |
| Self-host complexity creep | Settings page test buttons validate keys before save. Docker compose stays one command. Two new env vars: `ANTHROPIC_API_KEY`, `AGENT_DAILY_COST_USD_CAP` |
| Helius dependency cliff | Pre-existing risk, not new. Mitigation belongs in a separate spec (multi-provider abstraction in `packages/helius`). Out of scope for Phase 6 |

## 7. Success criteria

- Discovery loop surfaces at least one wallet per day that you choose to add to your watchlist
- Anomaly detector fires fewer than five false positives per day on a 20-wallet watchlist
- Daily LLM cost under two dollars on a single-user instance with default settings
- Dashboard server-renders in under 500ms TTFB
- Self-host install: three commands (`docker compose up -d`, `bun run migrate`, paste keys in `/settings`)
- Zero LLM-cost surprises (every dollar visible in `agent_runs`)

## 8. Deliverables

- `apps/web/` populated with Next 16 frontend (single dashboard, four detail pages, intel page, agent page, settings)
- `packages/agent/` populated with Claude SDK integration, tool registry, three cron loops plus one on-demand
- New tables: `tokens`, `discovered_wallets`, `agent_briefs`, `agent_runs`. Modified: `watch_events` (+3 cols), `token_scans` (+1 col)
- Updated `README.md` reflecting Phase 5 shipped state and Phase 6 frontend
- Updated `CLAUDE.md` adding agent and Anthropic context to project instructions
- Updated `docker-compose.yml` with the fused app container
- New env vars documented in `.env.example`: `ANTHROPIC_API_KEY`, `AGENT_DAILY_COST_USD_CAP`, `AGENT_MAX_TOOL_CALLS_PER_RUN`, `AGENT_MAX_INPUT_TOKENS_PER_RUN`, `MORNING_BRIEF_HOUR_LOCAL`, `MORNING_BRIEF_TZ`, `DEXSCREENER_BASE_URL`, scoring weights `W_FREQ`, `W_PNL`, `W_TIMING`, `P_BUNDLER`, `P_SYBIL`, `P_FRESH`
- Per-sub-phase PRs, each with integration tests against real Postgres and Helius (skipped when key absent, per existing convention)

## 9. Open questions, deferred (not blocking)

1. TG and Twitter signal ingestion as Phase 7+ if Phase 6 succeeds
2. CLI surface (`thirdeye agent investigate <mint>`) as cheap post-Phase 6 power-user addition
3. LaserStream gRPC migration for sub-second anomaly latency, Phase 7+
4. Embedding-based wallet similarity ("find wallets that behave like this proven smart-money one") as v2 ML work

## Appendix A: Cost model assumptions

Per-run estimates at default settings, Haiku 4.5 pricing as of design date:

| Loop | LLM cost / run | Helius cost / run | Frequency | Daily cost |
|---|---|---|---|---|
| Discovery | ~$0.04 | ~50 enhanced-tx | hourly | ~$0.96 |
| Anomaly | ~$0.01 (only when fires) | 1 / wallet checked | every 15 min | ~$0.20 (assuming 5 firings/day) |
| Morning brief | ~$0.02 | 0 (uses cached data) | daily | ~$0.02 |
| Cluster expand | ~$0.10 (Sonnet) | ~10-20 enhanced-tx | on-demand | variable |

Headline daily total at default: ~$1.18 LLM cost on a 20-wallet watchlist, well under the $10 default cap. Heavy day with 10 cluster expansions: ~$2.18.

## Appendix B: Env var reference (additions)

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Agent budget
AGENT_DAILY_COST_USD_CAP=10
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

- Phase 6 establishes the agent infrastructure. Adding new agent loops in Phase 7+ becomes incremental: new worker task, new prompt, new tool registration.
- The `agent_runs` audit trail makes scoring-weight experiments measurable: A/B score formulas by date range, see candidate add-rate.
- The `RiskBadges` component should stay register-stable across Phase 6 detail pages so future Phase 4 Intel page integrations have a consistent visual vocabulary.
- The hardest design constraint to maintain across future work is the anti-card density. Phase 7+ work should consult this spec's Section 4 before adding new dashboard widgets.
