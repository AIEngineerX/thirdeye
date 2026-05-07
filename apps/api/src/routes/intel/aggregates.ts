import { type DbClient, intelAggregates, tokenScans, walletChecks } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";
import { AGGREGATE_KEYS } from "../../workers/refresh-aggregates";

type Variables = { db: DbClient };

// Auth attaches per-route (not via use("*")). When multiple sub-routers share
// a prefix (here /api/db/intel with feed.ts), wildcard middleware leaks across
// them. Per-route attachment prevents that.
export const intelAggregatesRoutes = new Hono<{ Variables: Variables }>();

interface AggRow {
  key: string;
  payload: unknown;
  updatedAt: Date | string;
}

function toIso(t: Date | string): string {
  return t instanceof Date ? t.toISOString() : new Date(t).toISOString();
}

intelAggregatesRoutes.get("/aggregates", requireAuth, async (c) => {
  const db = c.get("db");
  const rows = (await db.select().from(intelAggregates)) as unknown as AggRow[];
  const out: Record<string, Record<string, unknown> | undefined> = {};
  for (const r of rows) {
    const updatedAt = toIso(r.updatedAt);
    if (r.key === AGGREGATE_KEYS.pulse24h) out.pulse24h = { ...(r.payload as object), updatedAt };
    else if (r.key === AGGREGATE_KEYS.allTime)
      out.allTime = { ...(r.payload as object), updatedAt };
    else if (r.key === AGGREGATE_KEYS.riskDist)
      out.riskDist = { ...(r.payload as object), updatedAt };
    else if (r.key === AGGREGATE_KEYS.heatmap)
      out.heatmap = { ...(r.payload as object), updatedAt };
  }
  return c.json(out);
});

intelAggregatesRoutes.get("/recent/scans", requireAuth, async (c) => {
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const offset = clampInt(c.req.query("offset"), 0, 0, 1000);
  const db = c.get("db");
  const rows = await db
    .select({
      id: tokenScans.id,
      mint: tokenScans.mint,
      symbol: tokenScans.symbol,
      name: tokenScans.name,
      riskPct: tokenScans.riskPct,
      verdict: tokenScans.verdict,
      sybilFlag: tokenScans.sybilFlag,
      scannedAt: tokenScans.scannedAt,
    })
    .from(tokenScans)
    .orderBy(sql`${tokenScans.scannedAt} DESC`)
    .limit(limit)
    .offset(offset);
  return c.json({ items: rows, limit, offset });
});

intelAggregatesRoutes.get("/recent/checks", requireAuth, async (c) => {
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const offset = clampInt(c.req.query("offset"), 0, 0, 1000);
  const db = c.get("db");
  const rows = await db
    .select({
      id: walletChecks.id,
      address: walletChecks.address,
      score: walletChecks.score,
      verdict: walletChecks.verdict,
      checkedAt: walletChecks.checkedAt,
    })
    .from(walletChecks)
    .orderBy(sql`${walletChecks.checkedAt} DESC`)
    .limit(limit)
    .offset(offset);
  return c.json({ items: rows, limit, offset });
});

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
