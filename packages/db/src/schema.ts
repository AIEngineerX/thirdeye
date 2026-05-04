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
