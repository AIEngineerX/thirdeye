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

// Wallets — cached profiles, spec §9
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
    // Phase 5d: realized SOL PnL across last 100 swaps over the 30d window
    // preceding the most recent check. Nullable — older rows pre-migration
    // and wallets with zero swap history both legitimately have null.
    realizedPnlSol: numeric("realized_pnl_sol"),
    lastChecked: timestamp("last_checked", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firstFunderIdx: index("wallets_first_funder_idx").on(t.firstFunder),
    tagsIdx: index("wallets_tags_idx").using("gin", t.tags),
  }),
);

// Wallet checks — history of /wallet-check writes, spec §9
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

// Token scans — history of /scan writes, spec §9
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

// Funders — denormalized for fast funder-fanout queries, spec §9
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

// Aggregates — refreshed every 30s by cron, spec §9
export const intelAggregates = pgTable("intel_aggregates", {
  key: text("key").primaryKey(), // '24h_pulse' | 'all_time' | 'risk_dist' | 'heatmap'
  payload: jsonb("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Phase 5e: Helius webhook subscriptions ──────────────────────────────────

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
