import { Hono } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { generateToken } from "../lib/tokens";

export const authRoutes = new Hono<{ Variables: { db: DbClient } }>();

authRoutes.post("/auth", async (c) => {
  const db = c.get("db");
  const { token, expiresAt } = generateToken();

  await db.insert(authTokens).values({ token, expiresAt });

  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
