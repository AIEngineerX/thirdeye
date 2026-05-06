import { type DbClient, intelAggregates } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import {
  type AllTime,
  type Heatmap,
  type Pulse24h,
  type RiskDist,
  allTime,
  heatmap,
  pulse24h,
  riskDist,
} from "../lib/aggregator";

export const AGGREGATE_KEYS = {
  pulse24h: "24h_pulse",
  allTime: "all_time",
  riskDist: "risk_dist",
  heatmap: "heatmap",
} as const;

export async function refreshAggregates(db: DbClient): Promise<void> {
  const [p, a, r, h] = await Promise.all([pulse24h(db), allTime(db), riskDist(db), heatmap(db)]);
  await Promise.all([
    upsert(db, AGGREGATE_KEYS.pulse24h, p),
    upsert(db, AGGREGATE_KEYS.allTime, a),
    upsert(db, AGGREGATE_KEYS.riskDist, r),
    upsert(db, AGGREGATE_KEYS.heatmap, h),
  ]);
}

async function upsert(
  db: DbClient,
  key: string,
  payload: Pulse24h | AllTime | RiskDist | Heatmap,
): Promise<void> {
  await db
    .insert(intelAggregates)
    .values({ key, payload: payload as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: intelAggregates.key,
      set: {
        payload: sql`EXCLUDED.payload`,
        updatedAt: sql`now()`,
      },
    });
}
