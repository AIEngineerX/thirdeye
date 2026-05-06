import { type DbClient, createDb } from "@thirdeye/db";
import { sql } from "drizzle-orm";
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
import { tokenScan } from "./routes/token";
import { walletCheck } from "./routes/wallet";

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
app.get("/health", async (c) => {
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ ok: true, db: "ok" });
  } catch (e) {
    console.error("[health] db ping failed", e);
    return c.json({ ok: false, db: "unreachable" }, 503);
  }
});
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

const walletCheckLimit = rateLimit({
  name: "wallet_check",
  limit: env.WALLET_CHECK_LIMIT,
  windowSec: env.WALLET_CHECK_WINDOW_SEC,
  bypassOnByok: false,
});

const walletRouter = new Hono<{ Variables: Variables }>();
walletRouter.use("*", requireAuth);
walletRouter.use("*", walletCheckLimit);
walletRouter.route("/", walletCheck);
app.route("/api/wallet", walletRouter);

const scanTokenLimit = rateLimit({
  name: "scan_token",
  limit: env.SCAN_TOKEN_LIMIT,
  windowSec: env.SCAN_TOKEN_WINDOW_SEC,
  bypassOnByok: true,
});

const tokenRouter = new Hono<{ Variables: Variables }>();
tokenRouter.use("*", requireAuth);
tokenRouter.use("*", scanTokenLimit);
tokenRouter.route("/", tokenScan);
app.route("/api/token", tokenRouter);

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
