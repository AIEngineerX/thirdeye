import type { DbClient } from "@thirdeye/db";
import { Hono } from "hono";
import { type DashboardBundle, buildDashboard } from "../../lib/dashboard";

type Variables = { db: DbClient };
export const dashboardRoutes = new Hono<{ Variables: Variables }>();

const CACHE_TTL_MS = 15_000;
let cache: { at: number; bundle: DashboardBundle } | null = null;

dashboardRoutes.get("/", async (c) => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return c.json(cache.bundle, 200, { "X-ThirdEye-Cache": "HIT" });
  }
  const bundle = await buildDashboard(c.get("db"));
  cache = { at: now, bundle };
  return c.json(bundle, 200, { "X-ThirdEye-Cache": "MISS" });
});

export function _resetDashboardCache(): void {
  cache = null;
}
