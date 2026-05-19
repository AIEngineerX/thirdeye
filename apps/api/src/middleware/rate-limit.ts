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

// Accepts only keys that look like real provider keys (UUIDs, opaque tokens).
// Without this, "x", " ", "invalid" used to be enough to bypass rate limits.
// We are not authenticating the key here — that happens at Helius — only
// keeping trivial bypass values from clearing the gate.
const BYOK_KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidByokKey(raw: string | undefined): raw is string {
  return typeof raw === "string" && BYOK_KEY_SHAPE.test(raw);
}

export function rateLimit(
  opts: RateLimitOptions,
): MiddlewareHandler<{ Variables: { db: DbClient } }> {
  const { name, limit, windowSec, bypassOnByok } = opts;
  return async (c, next) => {
    // Self-host bypass: rate limits are a hosted-instance concern.
    if (process.env.PUBLIC_INSTANCE_MODE !== "true") return next();

    const byokHeader = c.req.header("X-User-Helius-Key");
    const byokValid = bypassOnByok && isValidByokKey(byokHeader);

    const token = c.req.header("X-Auth-Token");
    if (!token) return next(); // auth middleware handles 401

    const db = c.get("db");
    const now = new Date();
    const windowFloor = new Date(now.getTime() - windowSec * 1000);

    // BYOK-validated calls bypass the limit BUT still increment a parallel
    // bucket (`{name}_byok`) so abuse-detection / audit has visibility into
    // BYOK usage volumes.
    const bucketName = byokValid ? `${name}_byok` : name;

    const result = await db.execute(sql`
      UPDATE auth_tokens SET rate_bucket = jsonb_set(
        rate_bucket,
        ARRAY[${bucketName}]::text[],
        CASE
          WHEN (rate_bucket->${bucketName}->>'windowStart') IS NULL
            OR (rate_bucket->${bucketName}->>'windowStart')::timestamptz < ${windowFloor.toISOString()}::timestamptz
          THEN jsonb_build_object('windowStart', ${now.toISOString()}::text, 'count', 1)
          ELSE jsonb_build_object(
            'windowStart', rate_bucket->${bucketName}->>'windowStart',
            'count', ((rate_bucket->${bucketName}->>'count')::int + 1)
          )
        END,
        true
      )
      WHERE token = ${token}
      RETURNING (rate_bucket->${bucketName}->>'count')::int AS new_count,
                (rate_bucket->${bucketName}->>'windowStart')::timestamptz AS window_start
    `);

    const row = (result as unknown as RateLimitRow[])[0];
    if (!row) return next(); // token row gone — auth middleware will 401

    // BYOK path: counted, never blocked.
    if (byokValid) return next();

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
