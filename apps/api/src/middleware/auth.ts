import type { MiddlewareHandler } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { eq, sql } from "drizzle-orm";

export const requireAuth: MiddlewareHandler<{ Variables: { db: DbClient } }> = async (c, next) => {
  const token = c.req.header("X-Auth-Token");
  if (!token) return c.json({ error: "missing X-Auth-Token" }, 401);

  const db = c.get("db");
  const rows = await db.select().from(authTokens).where(eq(authTokens.token, token));
  const row = rows[0];
  if (!row) return c.json({ error: "invalid token" }, 401);
  if (row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "token expired" }, 401);
  }

  // Use Postgres `now()` for consistency with `lastUsedAt`'s `defaultNow()` at INSERT.
  // Mixing JS `new Date()` with PG `now()` on the same column is fragile under any
  // host-vs-container clock skew.
  await db
    .update(authTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(authTokens.token, token));

  await next();
};
