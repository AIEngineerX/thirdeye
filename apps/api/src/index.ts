import { type DbClient, createDb } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { initIntelBus } from "./lib/intel-bus";
import { requireAuth } from "./middleware/auth";
import { bodySizeLimit } from "./middleware/body-size";
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
import { heliusWebhook } from "./routes/helius-webhook";
import { intelAggregatesRoutes, intelFeed, intelFundersRoutes } from "./routes/intel";
import { tokenScan } from "./routes/token";
import { tokensRoutes } from "./routes/tokens";
import { walletCheck, walletPnl } from "./routes/wallet";
import { trackedRoutes } from "./routes/tracked";
import { watchesRoutes } from "./routes/watches";
import { startWorker } from "./workers/runner";

const { db, sql: pgSql } = createDb(env.DATABASE_URL);

type Variables = { db: DbClient };

const app = new Hono<{ Variables: Variables }>();

app.use("*", logger());

// L2 (audit): cap request body size before any parser sees it. Bun has no
// default maxRequestBodySize so a multi-megabyte body would be loaded into
// memory before downstream handlers ran. 64KB fits the largest legitimate
// request (100-element batch-identity body ~5KB) with plenty of headroom.
app.use("*", bodySizeLimit());

app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "X-Auth-Token", "X-User-Helius-Key", "X-User-Anthropic-Key"],
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

app.get("/api/db/protected-probe", requireAuth, (c) => c.json({ ok: true }));

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
// Mount at the specific prefix; mounting at "/" caused use("*") on this
// router to leak requireAuth onto every route in the app (including
// public endpoints like /api/helius-webhook).
app.route("/api/helius-rpc", heliusRpcRouter);

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
walletRouter.route("/", walletPnl);
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

// Intel module — read aggregates + funders apply requireAuth per-route
// (NOT via use("*")) because SSE feed lives at the same /api/db/intel
// prefix. A wildcard middleware would leak across sub-routers and
// intercept /feed before its query-param token check could run.
app.route("/api/db/intel", intelAggregatesRoutes);
app.route("/api/db/intel", intelFundersRoutes);

const watchesRouter = new Hono<{ Variables: Variables }>();
watchesRouter.use("*", requireAuth);
watchesRouter.route("/", watchesRoutes);
app.route("/api/db/watches", watchesRouter);

const trackedRouter = new Hono<{ Variables: Variables }>();
trackedRouter.use("*", requireAuth);
trackedRouter.route("/", trackedRoutes);
app.route("/api/db/tracked", trackedRouter);

// Phase 6a — token cache (read-only). Auth required since the contents
// are populated by user-driven scans + the worker; no rate-limit because
// these are cheap indexed reads.
const tokensRouter = new Hono<{ Variables: Variables }>();
tokensRouter.use("*", requireAuth);
tokensRouter.route("/", tokensRoutes);
app.route("/api/db/tokens", tokensRouter);

app.route("/api/helius-webhook", heliusWebhook);

const intelFeedRouter = new Hono<{ Variables: Variables }>();
intelFeedRouter.route("/", intelFeed);
app.route("/api/db/intel", intelFeedRouter);

await initIntelBus(pgSql);

// Background worker — only when this file is the entrypoint, never under tests
// (tests import `{ app }` and would otherwise spin up cron + DB schema install).
if (import.meta.main) {
  startWorker({
    connectionString: env.DATABASE_URL,
    db,
    sql: pgSql,
    serverHeliusKey: env.HELIUS_API_KEY,
    smartMoneyMinSol: env.SMART_MONEY_MIN_SOL,
  })
    .then(() => console.log("[worker] graphile-worker started"))
    .catch((e) => console.error("[worker] start failed", e));
}

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
