import type { DbClient } from "@thirdeye/db";
import { ProxyError } from "@thirdeye/helius";
import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowSec: number;
  bypassOnByok: boolean;
}

interface RateLimitRow {
  new_count: string | number;
  window_start: string | Date;
}

export function rateLimit(
  opts: RateLimitOptions,
): MiddlewareHandler<{ Variables: { db: DbClient } }> {
  const { name, limit, windowSec, bypassOnByok } = opts;
  return async (c, next) => {
    // Self-host bypass: rate limits are a hosted-instance concern.
    if (process.env.PUBLIC_INSTANCE_MODE !== "true") return next();

    // BYOK bypass for credit-protection limits (per spec §16).
    if (bypassOnByok && c.req.header("X-User-Helius-Key")) return next();

    const token = c.req.header("X-Auth-Token");
    if (!token) return next(); // auth middleware handles 401

    const db = c.get("db");
    const now = new Date();
    const windowFloor = new Date(now.getTime() - windowSec * 1000);

    const result = await db.execute(sql`
      UPDATE auth_tokens SET rate_bucket = jsonb_set(
        rate_bucket,
        ARRAY[${name}]::text[],
        CASE
          WHEN (rate_bucket->${name}->>'windowStart') IS NULL
            OR (rate_bucket->${name}->>'windowStart')::timestamptz < ${windowFloor.toISOString()}::timestamptz
          THEN jsonb_build_object('windowStart', ${now.toISOString()}::text, 'count', 1)
          ELSE jsonb_build_object(
            'windowStart', rate_bucket->${name}->>'windowStart',
            'count', ((rate_bucket->${name}->>'count')::int + 1)
          )
        END,
        true
      )
      WHERE token = ${token}
      RETURNING (rate_bucket->${name}->>'count')::int AS new_count,
                (rate_bucket->${name}->>'windowStart')::timestamptz AS window_start
    `);

    const row = (result as unknown as RateLimitRow[])[0];
    if (!row) return next(); // token row gone — auth middleware will 401

    const newCount = Number(row.new_count);
    const windowStart = new Date(row.window_start);
    const resetAt = new Date(windowStart.getTime() + windowSec * 1000);
    const retryAfterSec = Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Reset", resetAt.toISOString());

    if (newCount > limit) {
      c.header("X-RateLimit-Remaining", "0");
      c.header("Retry-After", String(retryAfterSec));
      const { status, ...body } = ProxyError.rateLimited(name, limit, windowSec, retryAfterSec);
      return c.json(body, status as 429);
    }

    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - newCount)));
    await next();
  };
}
