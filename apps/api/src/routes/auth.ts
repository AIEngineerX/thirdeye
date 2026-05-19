import { type DbClient, authTokens } from "@thirdeye/db";
import { Hono } from "hono";
import { env } from "../env";
import { tryAuthIssue } from "../lib/auth-issue-rate-limit";
import { getClientIp } from "../lib/client-ip";
import { generateToken } from "../lib/tokens";

export const authRoutes = new Hono<{ Variables: { db: DbClient } }>();

authRoutes.post("/auth", async (c) => {
  const db = c.get("db");

  // H2: gate issuance per client IP under PUBLIC_INSTANCE_MODE. Without
  // this gate, per-token rate limits on other routes are trivially defeated
  // by minting a fresh token before each 429. Read process.env directly
  // (matching the rate-limit middleware pattern) so tests can flip the mode
  // without re-importing the env module.
  if (process.env.PUBLIC_INSTANCE_MODE === "true") {
    const ip = getClientIp(c, true);
    const r = await tryAuthIssue(db, {
      ip,
      limit: env.AUTH_ISSUE_LIMIT_PER_HOUR,
      windowSec: 3600,
    });
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfterSec));
      c.header("X-RateLimit-Limit", String(env.AUTH_ISSUE_LIMIT_PER_HOUR));
      c.header("X-RateLimit-Reset", r.resetAt.toISOString());
      return c.json(
        {
          error: "auth_issue_rate_limited",
          retryAfterSec: r.retryAfterSec,
          limit: env.AUTH_ISSUE_LIMIT_PER_HOUR,
          windowSec: 3600,
        },
        429,
      );
    }
  }

  const { token, expiresAt } = generateToken();
  await db.insert(authTokens).values({ token, expiresAt });

  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
