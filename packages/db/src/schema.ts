import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Anonymous session tokens — spec §7, §9
export const authTokens = pgTable("auth_tokens", {
  token: text("token").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '7 days'`),
  rateBucket: jsonb("rate_bucket").notNull().default(sql`'{}'::jsonb`),
});

// H2 — IP-keyed rate limit on POST /api/db/auth (token issuance). Per-token
// limits elsewhere are defeated by minting a fresh token before each block;
// this bucket caps issuances themselves under PUBLIC_INSTANCE_MODE.
export const authIssueRateBuckets = pgTable("auth_issue_rate_buckets", {
  ip: text("ip").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
});

// M1 — one-time tickets for SSE upgrades. EventSource can't send custom
// headers, so historically the auth token was passed in the URL as
// `?token=...` which leaks into logs (server, reverse proxy, edge, browser
// history). New flow: client POSTs to /api/db/intel/feed/ticket with
// X-Auth-Token header, server returns an opaque ticket valid for 30s and
// consumed on first use; the SSE URL is `?ticket=...`.
export const sseTickets = pgTable("sse_tickets", {
  ticket: text("ticket").primaryKey(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wallets = pgTable(
  "wallets",
  {
    address: text("address").primaryKey(),
    firstFunder: text("first_funder"),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    solBalance: numeric("sol_balance"),
    usdValue: numeric("usd_value"),
    txCount: integer("tx_count"),
    ageDays: integer("age_days"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    realizedPnlSol: numeric("realized_pnl_sol"),
    lastChecked: timestamp("last_checked", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firstFunderIdx: index("wallets_first_funder_idx").on(t.firstFunder),
    tagsIdx: index("wallets_tags_idx").using("gin", t.tags),
  }),
);

// `id` mode: "number" — JS number is safe to 2^53, far beyond any realistic count.
// `mode: "bigint"` would return native BigInt which is NOT JSON-serializable
// and would throw inside Hono's c.json().
export const walletChecks = pgTable(
  "wallet_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    address: text("address")
      .notNull()
      .references(() => wallets.address),
    score: integer("score").notNull(),
    verdict: text("verdict").notNull(), // CLEAN | LOW | MEDIUM | HIGH
    payload: jsonb("payload").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: index("wallet_checks_address_idx").on(t.address, t.checkedAt.desc()),
  }),
);

export const tokenScans = pgTable(
  "token_scans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    launchpad: text("launchpad"),
    totalHolders: integer("total_holders"),
    scannedHolders: integer("scanned_holders"),
    clusterCount: integer("cluster_count"),
    clusteredPct: numeric("clustered_pct"),
    lpPct: numeric("lp_pct"),
    lockedPct: numeric("locked_pct"),
    riskPct: numeric("risk_pct"),
    sybilFlag: boolean("sybil_flag").notNull().default(false),
    verdict: text("verdict"), // CLEAN | LOW_RISK | HIGH_RISK
    payload: jsonb("payload").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mintIdx: index("token_scans_mint_idx").on(t.mint, t.scannedAt.desc()),
  }),
);

// denormalized for fast funder-fanout queries
export const funders = pgTable(
  "funders",
  {
    address: text("address").primaryKey(),
    fanoutCount: integer("fanout_count").notNull().default(0),
    clusterCount: integer("cluster_count").notNull().default(0),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fanoutIdx: index("funders_fanout_idx").on(t.fanoutCount.desc()),
  }),
);

export const intelAggregates = pgTable("intel_aggregates", {
  key: text("key").primaryKey(), // '24h_pulse' | 'all_time' | 'risk_dist' | 'heatmap'
  payload: jsonb("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-(token, address) row tracking which session is interested in which
// wallet. The set of distinct addresses across all rows is the source of
// truth we sync into Helius's single managed webhook.
export const watches = pgTable(
  "watches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    address: text("address").notNull(),
    label: text("label"),
    token: text("token")
      .notNull()
      .references(() => authTokens.token, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: index("watches_address_idx").on(t.address),
  }),
);

// Events delivered by Helius for any watched address. Persisted for replay
// and history; the live SSE feed emits them as they arrive (intel-bus).
export const watchEvents = pgTable(
  "watch_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    address: text("address").notNull(),
    signature: text("signature").notNull(),
    type: text("type"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: index("watch_events_address_idx").on(t.address, t.receivedAt.desc()),
  }),
);

// Single-row registry of the Helius webhook this instance manages. Stores
// the Helius-issued webhookID so we can call updateWebhook with the merged
// address set whenever a user adds/removes a watch. lastSyncedAddressCount
// is purely informational (drift-detection in logs, not a correctness gate).
export const heliusWebhooks = pgTable("helius_webhooks", {
  id: integer("id").primaryKey(), // hardcoded 1 — single-row table
  webhookId: text("webhook_id").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAddressCount: integer("last_synced_address_count").notNull().default(0),
});

// Overflow table for intel-bus events whose JSON payload exceeds the
// Postgres NOTIFY 8000-byte limit. The bus INSERTs a row, NOTIFYs with the
// row id, and the subscriber fetches and deletes the row on dispatch.
// Bounded growth: rows live milliseconds in the happy path.
export const intelEvents = pgTable("intel_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 6a — cached price/MC for tracked Solana tokens. Refreshed by the
// `tokens-refresh` worker from a PriceSource (DexScreener in v1). Mints are
// seeded by `persistScan` (so any token that's been scanned auto-tracks);
// future phases may add other seed paths (e.g. discovered_wallets source_mints).
export const tokens = pgTable(
  "tokens",
  {
    mint: text("mint").primaryKey(),
    symbol: text("symbol"),
    name: text("name"),
    mcUsd: numeric("mc_usd"),
    priceUsd: numeric("price_usd"),
    mc24hPct: numeric("mc_24h_pct"),
    liquidityUsd: numeric("liquidity_usd"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Worker selects "oldest refresh first" — index supports both that and
    // the hot-tokens API (filtered on last_refreshed_at recency).
    refreshedIdx: index("tokens_last_refreshed_idx").on(t.lastRefreshedAt.desc()),
  }),
);

// Curated smart-money watchlist with a quality snapshot captured from Solana
// Tracker at add time. Distinct from `watches` (session-scoped, generic).
export const trackedWallets = pgTable("tracked_wallets", {
  address: text("address").primaryKey(),
  label: text("label"),
  source: text("source").notNull().default("manual"), // 'manual' | 'leaderboard'
  winRate: numeric("win_rate"),
  realizedPnlUsd: numeric("realized_pnl_usd"),
  roi: numeric("roi"),
  tokensTraded: integer("tokens_traded"),
  identity: jsonb("identity"),
  pnlSyncedAt: timestamp("pnl_synced_at", { withTimezone: true }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  signalSignals: integer("signal_signals").notNull().default(0),
  signalWins: integer("signal_wins").notNull().default(0),
  signalWinrate: numeric("signal_winrate"),
});

// Normalized swaps parsed from tracked wallets' Helius enhanced events. Source
// of truth for confluence queries and the smart-money feed history.
// No FK from `wallet` -> tracked_wallets.address by design: feed history must
// survive a wallet being untracked, so untracking never cascades trade rows.
export const smartTrades = pgTable(
  "smart_trades",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    wallet: text("wallet").notNull(),
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    side: text("side").notNull(), // 'buy' | 'sell'
    solAmount: numeric("sol_amount"),
    usdValue: numeric("usd_value"),
    tokenAmount: numeric("token_amount"),
    program: text("program"),
    signature: text("signature").notNull(),
    tradedAt: timestamp("traded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sigWalletUniq: unique("smart_trades_sig_wallet_uniq").on(t.signature, t.wallet),
    mintSideTimeIdx: index("smart_trades_mint_side_time_idx").on(t.mint, t.side, t.tradedAt.desc()),
    tradedAtIdx: index("smart_trades_traded_at_idx").on(t.tradedAt.desc()),
  }),
);

// A promoted independent buy-confluence, tracked to an outcome. co_funded
// clusters are written here too (status='closed', trust='co_funded') as an
// audit trail of what a naive tracker would have called but we suppressed.
export const signals = pgTable(
  "signals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    walletCount: integer("wallet_count").notNull(),
    wallets: jsonb("wallets").notNull(), // string[] — jsonb dodges the array-binding bug
    trust: text("trust").notNull(), // 'independent' | 'co_funded'
    sharedFunder: text("shared_funder"),
    callMc: numeric("call_mc"),
    callPrice: numeric("call_price"),
    firstBuyAt: timestamp("first_buy_at", { withTimezone: true }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    safePromotedAt: timestamp("safe_promoted_at", { withTimezone: true }),
    safeCallMc: numeric("safe_call_mc"),
    currentMc: numeric("current_mc"),
    athMc: numeric("ath_mc"),
    athMultiplier: numeric("ath_multiplier"),
    safeAthMultiplier: numeric("safe_ath_multiplier"),
    isHit: boolean("is_hit").notNull().default(false),
    safeIsHit: boolean("safe_is_hit").notNull().default(false),
    peakAt: timestamp("peak_at", { withTimezone: true }),
    status: text("status").notNull().default("open"), // 'open' | 'closed'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // NOTE: the partial unique index `signals_open_mint_uniq` (UNIQUE (mint)
    // WHERE status='open') that the ON CONFLICT upsert depends on lives only in
    // migration 0011_signals.sql — Drizzle's index() can't model a WHERE clause.
    statusDetectedIdx: index("signals_status_detected_idx").on(t.status, t.detectedAt.desc()),
    mintIdx: index("signals_mint_idx").on(t.mint),
  }),
);

// Phase 6b — audit trail for every agent run plus source of truth for the
// daily-budget cap. Sum of cost_usd over today (UTC) is what the advisory
// lock at packages/agent/src/budget.ts reads + writes inside one tx guarded
// by pg_advisory_xact_lock(hashtext('agent_daily_budget')).
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(), // 'discovery' | 'anomaly' | 'morning_brief' | 'cluster_expand' | 'tg_query'
    status: text("status").notNull(), // 'running' | 'success' | 'failed' | 'skipped_budget' | 'capped'
    model: text("model").notNull(),
    toolCallsMade: integer("tool_calls_made").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // Cache-read tokens (cheap tier, ~$0.10/MTok). Older rows here may
    // include cache-creation tokens summed in — they were not split until
    // migration 0006.
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    // Cache-creation tokens (expensive tier, ~$1.25/MTok for Sonnet).
    // Added in migration 0006 so audit-row cost reconstruction is accurate.
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    costUsd: numeric("cost_usd").notNull().default("0"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    startedAtIdx: index("agent_runs_started_at_idx").on(t.startedAt.desc()),
    kindStartedAtIdx: index("agent_runs_kind_started_at_idx").on(t.kind, t.startedAt.desc()),
  }),
);

// Dormant candidate pool (spec §6). Never webhook-subscribed; promotion copies
// a row into tracked_wallets. Behavior columns computed from the seed corpus.
export const candidateWallets = pgTable(
  "candidate_wallets",
  {
    address: text("address").primaryKey(),
    handle: text("handle"),
    displayName: text("display_name"),
    twitterHandle: text("twitter_handle"),
    source: text("source").notNull(),
    srcPnl7d: numeric("src_pnl_7d"),
    srcPnlAll: numeric("src_pnl_all"),
    srcWinRate: numeric("src_win_rate"),
    srcRank: integer("src_rank"),
    buysObserved: integer("buys_observed").notNull().default(0),
    earlyBuys: integer("early_buys").notNull().default(0),
    earlyRate: numeric("early_rate"),
    tokensTraded: integer("tokens_traded").notNull().default(0),
    promoted: boolean("promoted").notNull().default(false),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rankIdx: index("candidate_wallets_rank_idx").on(
      t.promoted,
      t.earlyRate.desc(),
      t.srcPnlAll.desc(),
    ),
  }),
);

// Migration 0009 adds a partial unique index on agent_runs that closes the
// tg-bot dedup race (audit L4 / bug-scan L4). Two concurrent Telegram
// updates with the same telegram_msg_id used to be able to both pass the
// SELECT EXISTS check before either INSERT committed, racing into double
// agent runs. The unique index over (metadata->>'telegram_msg_id') WHERE
// status != 'failed' makes the second INSERT fail at the DB level, so the
// dispatch handler can catch the unique-violation and treat it as
// "already handled" without a second agent run.
//
// Defined as raw SQL in the migration because drizzle's index() doesn't
// model `WHERE` clauses on partial indexes. Schema definition kept above
// as documentation.
