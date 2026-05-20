import type { DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

// Prune rows from tables that grow with traffic and have no semantic value
// past their natural TTL. Cheap O(N) DELETE on indexed/keyed columns; safe
// to run as often as we like.
//
// sse_tickets: any ticket past expires_at is dead. Tickets are 30s TTL so
//   anything we DELETE here is guaranteed to never be claimed.
//
// auth_issue_rate_buckets: per-IP rows; the in-row count + window_start
//   are reset every time the same IP starts a new window. Rows where
//   window_start is older than (window + cushion) belong to IPs we
//   haven't seen recently — safe to drop. They'll be re-created on the
//   next request from that IP.

export interface CleanupTablesStats {
  ssesTicketsDeleted: number;
  authIssueRateBucketsDeleted: number;
}

export async function cleanupTables(db: DbClient): Promise<CleanupTablesStats> {
  const nowIso = new Date().toISOString();
  // Window is 1h (see auth.ts); 2h gives a safety cushion so we don't
  // prune a row whose window is still active. The window-reset logic in
  // tryAuthIssue compares `window_start < (now - windowSec)`, so anything
  // older than (window + cushion) is provably reset-eligible already.
  const authStaleCutoffIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

  const ssesTickets = (await db.execute(sql`
    DELETE FROM sse_tickets WHERE expires_at <= ${nowIso}::timestamptz
  `)) as unknown as { count?: number };

  const authIssue = (await db.execute(sql`
    DELETE FROM auth_issue_rate_buckets WHERE window_start < ${authStaleCutoffIso}::timestamptz
  `)) as unknown as { count?: number };

  return {
    ssesTicketsDeleted: ssesTickets.count ?? 0,
    authIssueRateBucketsDeleted: authIssue.count ?? 0,
  };
}
