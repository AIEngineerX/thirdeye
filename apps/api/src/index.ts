import { type DbClient, createDb } from "@thirdeye/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { requireAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rate-limit";
import { authRoutes } from "./routes/auth";
import {
  balances,
  batchIdentity,
  fundedBy,
  rpc as heliusRpc,
  identity,
  transactions,
  transactionsBySig,
} from "./routes/helius";

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
app.route("/api/db", authRoutes); // /auth is unauthenticated by design (it issues tokens)

const protectedDb = new Hono<{ Variables: Variables }>();
protectedDb.use("*", requireAuth);
protectedDb.get("/protected-probe", (c) => c.json({ ok: true }));

app.route("/api/db", protectedDb);

const heliusProxyLimit = rateLimit({
  name: "helius_proxy",
  limit: env.HELIUS_PROXY_LIMIT,
  windowSec: env.HELIUS_PROXY_WINDOW_SEC,
  bypassOnByok: true,
});

const heliusRouter = new Hono<{ Variables: Variables }>();
heliusRouter.use("*", requireAuth);
heliusRouter.use("*", heliusProxyLimit);
heliusRouter.route("/", identity);
heliusRouter.route("/", balances);
heliusRouter.route("/", fundedBy);
heliusRouter.route("/", transactions);
heliusRouter.route("/", batchIdentity);
heliusRouter.route("/", transactionsBySig);
app.route("/api/helius", heliusRouter);

const heliusRpcRouter = new Hono<{ Variables: Variables }>();
heliusRpcRouter.use("*", requireAuth);
heliusRpcRouter.use("*", heliusProxyLimit);
heliusRpcRouter.route("/", heliusRpc);
app.route("/", heliusRpcRouter);

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
