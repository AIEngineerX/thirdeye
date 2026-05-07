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
import { heliusWebhook } from "./routes/helius-webhook";
import { intelAggregatesRoutes, intelFeed, intelFundersRoutes } from "./routes/intel";
import { tokenScan } from "./routes/token";
import { walletCheck } from "./routes/wallet";
import { watchesRoutes } from "./routes/watches";
import { startWorker } from "./workers/runner";

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

// Intel module — read aggregates + funders require auth; SSE feed handles
// its own query-param token check (EventSource can't send headers).
const intelReadRouter = new Hono<{ Variables: Variables }>();
intelReadRouter.use("*", requireAuth);
intelReadRouter.route("/", intelAggregatesRoutes);
intelReadRouter.route("/", intelFundersRoutes);
app.route("/api/db/intel", intelReadRouter);

// Phase 5e — watches CRUD (auth-protected) + public webhook ingest. The
// ingest endpoint validates Helius's auth header itself; it must NOT be
// behind requireAuth because Helius doesn't have an X-Auth-Token.
const watchesRouter = new Hono<{ Variables: Variables }>();
watchesRouter.use("*", requireAuth);
watchesRouter.route("/", watchesRoutes);
app.route("/api/db/watches", watchesRouter);

app.route("/api/helius-webhook", heliusWebhook);

const intelFeedRouter = new Hono<{ Variables: Variables }>();
intelFeedRouter.route("/", intelFeed);
app.route("/api/db/intel", intelFeedRouter);

// Background worker — only when this file is the entrypoint, never under tests
// (tests import `{ app }` and would otherwise spin up cron + DB schema install).
if (import.meta.main) {
  startWorker({
    connectionString: env.DATABASE_URL,
    db,
    serverHeliusKey: env.HELIUS_API_KEY,
    smartMoneyMinSol: env.SMART_MONEY_MIN_SOL,
  })
    .then(() => console.log("[worker] graphile-worker started"))
    .catch((e) => console.error("[worker] start failed", e));
}

console.log(`thirdeye api ready on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
export { app, db };
