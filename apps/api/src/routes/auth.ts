import { type DbClient, authTokens } from "@thirdeye/db";
import { Hono } from "hono";
import { generateToken } from "../lib/tokens";

export const authRoutes = new Hono<{ Variables: { db: DbClient } }>();

authRoutes.post("/auth", async (c) => {
  const db = c.get("db");
  const { token, expiresAt } = generateToken();

  await db.insert(authTokens).values({ token, expiresAt });

  return c.json({ token, expiresAt: expiresAt.toISOString() });
});
