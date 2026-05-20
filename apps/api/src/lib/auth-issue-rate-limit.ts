import type { DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

// H2: cap how many anonymous session tokens a given client IP can mint per
// window. Per-token rate limits elsewhere are defeated by minting a fresh
// token before each block, so this gate must sit on issuance itself.
//
// Implemented as an UPSERT with a windowed reset: if the existing row's
// window_start is older than (now - windowSec), reset to (now, 1); else
// increment count by 1. Returns the new count and the window's reset
// time so the caller can attach a Retry-After header.

export interface AuthIssueRateLimitResult {
  ok: boolean;
  count: number;
  resetAt: Date;
  retryAfterSec: number;
}

export interface AuthIssueRateLimitOptions {
  ip: string;
  limit: number;
  windowSec: number;
}

interface BucketRow {
  new_count: number;
  window_start: Date;
}

export async function tryAuthIssue(
  db: DbClient,
  opts: AuthIssueRateLimitOptions,
): Promise<AuthIssueRateLimitResult> {
  const { ip, limit, windowSec } = opts;
  const now = new Date();
  const windowFloorIso = new Date(now.getTime() - windowSec * 1000).toISOString();
  const nowIso = now.toISOString();

  const rows = (await db.execute(sql`
    INSERT INTO auth_issue_rate_buckets (ip, window_start, count)
    VALUES (${ip}, ${nowIso}::timestamptz, 1)
    ON CONFLICT (ip) DO UPDATE
      SET window_start = CASE
            WHEN auth_issue_rate_buckets.window_start < ${windowFloorIso}::timestamptz
              THEN ${nowIso}::timestamptz
            ELSE auth_issue_rate_buckets.window_start
          END,
          count = CASE
            WHEN auth_issue_rate_buckets.window_start < ${windowFloorIso}::timestamptz
              THEN 1
            ELSE auth_issue_rate_buckets.count + 1
          END
    RETURNING count AS new_count, window_start
  `)) as unknown as BucketRow[];

  const row = rows[0]!;
  const count = Number(row.new_count);
  const windowStart = new Date(row.window_start);
  const resetAt = new Date(windowStart.getTime() + windowSec * 1000);
  const retryAfterSec = Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

  return {
    ok: count <= limit,
    count,
    resetAt,
    retryAfterSec,
  };
}
