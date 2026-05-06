import type { DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

export interface Pulse24h {
  scans: number;
  checks: number;
  newClusters: number;
  newBundlers: number;
}

export interface AllTime {
  walletsProfiled: number;
  tokensScanned: number;
  clustersDetected: number;
  bundlersTagged: number;
}

export interface RiskDist {
  buckets: number[]; // length 10
  windowDays: number;
  total: number;
}

export interface HeatmapItem {
  mint: string;
  symbol: string | null;
  name: string | null;
  risk: number;
  verdict: string | null;
  scannedAt: string; // ISO8601
}

export interface Heatmap {
  items: HeatmapItem[];
}

export async function pulse24h(db: DbClient): Promise<Pulse24h> {
  const r = await db.execute<{
    scans: number;
    checks: number;
    new_clusters: number;
    new_bundlers: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM token_scans WHERE scanned_at >= now() - interval '24 hours') AS scans,
      (SELECT count(*)::int FROM wallet_checks WHERE checked_at >= now() - interval '24 hours') AS checks,
      (SELECT count(*)::int FROM funders WHERE last_seen >= now() - interval '24 hours' AND cluster_count > 0) AS new_clusters,
      (SELECT count(*)::int FROM wallets WHERE last_checked >= now() - interval '24 hours' AND 'BUNDLER' = ANY(tags)) AS new_bundlers
  `);
  const row = (r as unknown as Pulse24h_Row[])[0];
  return {
    scans: row?.scans ?? 0,
    checks: row?.checks ?? 0,
    newClusters: row?.new_clusters ?? 0,
    newBundlers: row?.new_bundlers ?? 0,
  };
}

export async function allTime(db: DbClient): Promise<AllTime> {
  const r = await db.execute<{
    wallets_profiled: number;
    tokens_scanned: number;
    clusters_detected: number;
    bundlers_tagged: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM wallets) AS wallets_profiled,
      (SELECT count(DISTINCT mint)::int FROM token_scans) AS tokens_scanned,
      (SELECT COALESCE(sum(cluster_count)::int, 0) FROM funders) AS clusters_detected,
      (SELECT count(*)::int FROM wallets WHERE 'BUNDLER' = ANY(tags)) AS bundlers_tagged
  `);
  const row = (r as unknown as AllTime_Row[])[0];
  return {
    walletsProfiled: row?.wallets_profiled ?? 0,
    tokensScanned: row?.tokens_scanned ?? 0,
    clustersDetected: row?.clusters_detected ?? 0,
    bundlersTagged: row?.bundlers_tagged ?? 0,
  };
}

export async function riskDist(db: DbClient): Promise<RiskDist> {
  const r = await db.execute<{ bucket: number; count: number }>(sql`
    SELECT
      LEAST(width_bucket(risk_pct::numeric, 0, 100, 10), 10)::int AS bucket,
      count(*)::int AS count
    FROM token_scans
    WHERE scanned_at >= now() - interval '7 days' AND risk_pct IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  const rows = r as unknown as { bucket: number; count: number }[];
  const buckets = new Array<number>(10).fill(0);
  let total = 0;
  for (const row of rows) {
    // width_bucket returns 1..10 for in-range values; clamp to index 0..9
    const idx = Math.max(0, Math.min(9, row.bucket - 1));
    buckets[idx] = (buckets[idx] ?? 0) + row.count;
    total += row.count;
  }
  return { buckets, windowDays: 7, total };
}

export async function heatmap(db: DbClient): Promise<Heatmap> {
  const r = await db.execute<{
    mint: string;
    symbol: string | null;
    name: string | null;
    risk_pct: string | null;
    verdict: string | null;
    scanned_at: Date;
  }>(sql`
    SELECT mint, symbol, name, risk_pct, verdict, scanned_at
    FROM token_scans
    ORDER BY scanned_at DESC
    LIMIT 20
  `);
  const rows = r as unknown as HeatmapRow[];
  const items: HeatmapItem[] = rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    risk: row.risk_pct === null ? 0 : Number(row.risk_pct),
    verdict: row.verdict,
    scannedAt:
      row.scanned_at instanceof Date
        ? row.scanned_at.toISOString()
        : new Date(row.scanned_at).toISOString(),
  }));
  return { items };
}

interface Pulse24h_Row {
  scans: number;
  checks: number;
  new_clusters: number;
  new_bundlers: number;
}
interface AllTime_Row {
  wallets_profiled: number;
  tokens_scanned: number;
  clusters_detected: number;
  bundlers_tagged: number;
}
interface HeatmapRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  risk_pct: string | null;
  verdict: string | null;
  scanned_at: Date | string;
}
