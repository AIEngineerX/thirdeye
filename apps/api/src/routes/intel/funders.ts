import { type DbClient, funders, tokenScans } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";

type Variables = { db: DbClient };

// Per-route auth: see comment in aggregates.ts.
export const intelFundersRoutes = new Hono<{ Variables: Variables }>();

type TopClusteredRow = {
  address: string;
  cluster_count: number;
  fanout_count: number;
  first_seen: Date | string;
  last_seen: Date | string;
};

type FunderClusterRow = {
  mint: string;
  symbol: string | null;
  name: string | null;
  scanned_at: Date | string;
  risk_pct: string | null;
  sybil_flag: boolean;
  member_count: number;
};

function toIso(t: Date | string): string {
  return t instanceof Date ? t.toISOString() : new Date(t).toISOString();
}

// Phase 5c: cross-token bundler intelligence. funders.cluster_count is
// already incremented in Phase 3 persistScan whenever a funder roots a
// detected cluster. Exposing it surfaces "this address has been the root
// across N tokens" — the highest-signal alpha view we can build on data
// already collected.

intelFundersRoutes.get("/funders/top-clustered", requireAuth, async (c) => {
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const db = c.get("db");
  const r = await db.execute<TopClusteredRow>(sql`
    SELECT address, cluster_count, fanout_count, first_seen, last_seen
    FROM funders
    WHERE cluster_count > 0
    ORDER BY cluster_count DESC, last_seen DESC
    LIMIT ${limit}
  `);
  const rows = r as unknown as TopClusteredRow[];
  return c.json({
    items: rows.map((row) => ({
      address: row.address,
      clusterCount: Number(row.cluster_count),
      fanoutCount: Number(row.fanout_count),
      firstSeen: toIso(row.first_seen),
      lastSeen: toIso(row.last_seen),
    })),
    limit,
  });
});

intelFundersRoutes.get("/funders/:addr/clusters", requireAuth, async (c) => {
  const addr = c.req.param("addr");
  const limit = clampInt(c.req.query("limit"), 50, 1, 200);
  const db = c.get("db");

  // Confirm the funder exists in our tracking table; otherwise 404.
  const exists = await db
    .select({ address: funders.address })
    .from(funders)
    .where(sql`${funders.address} = ${addr}`)
    .limit(1);
  if (exists.length === 0) {
    return c.json({ error: "not_found", message: "Funder not in tracking table" }, 404);
  }

  // Project the cluster matching this funder out of token_scans.payload.clusters[].
  // Postgres jsonb path: payload->'clusters' is the array; we filter where any
  // element has root === addr, then jsonb_array_elements to flatten and pick.
  const r = await db.execute<FunderClusterRow>(sql`
    SELECT
      ts.mint,
      ts.symbol,
      ts.name,
      ts.scanned_at,
      ts.risk_pct,
      ts.sybil_flag,
      jsonb_array_length(cluster->'members')::int AS member_count
    FROM ${tokenScans} ts,
    LATERAL jsonb_array_elements(ts.payload->'clusters') AS cluster
    WHERE cluster->>'root' = ${addr}
    ORDER BY ts.scanned_at DESC
    LIMIT ${limit}
  `);

  const rows = r as unknown as FunderClusterRow[];
  return c.json({
    funder: addr,
    clusters: rows.map((row) => ({
      mint: row.mint,
      symbol: row.symbol,
      name: row.name,
      scannedAt: toIso(row.scanned_at),
      riskPct: row.risk_pct === null ? null : Number(row.risk_pct),
      sybilFlag: row.sybil_flag,
      memberCount: row.member_count,
    })),
  });
});

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
