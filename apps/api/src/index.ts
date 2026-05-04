import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createDb, type DbClient } from "@thirdeye/db";
import { env } from "./env";

const { db } = createDb(env.DATABASE_URL);

type Variables = { db: DbClient };

const app = new Hono<{ Variables: Variables }>();

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "X-Auth-Token", "X-User-Helius-Key"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "internal_error" }, 500);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.get("/", (c) => c.text("ThirdEye API"));
app.get("/health", (c) => c.json({ ok: true }));

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
