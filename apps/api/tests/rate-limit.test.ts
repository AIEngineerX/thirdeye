import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authTokens, type DbClient } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./setup";
import { rateLimit } from "../src/middleware/rate-limit";
import { generateToken } from "../src/lib/tokens";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
});

async function issueToken(db: DbClient): Promise<string> {
  const t = generateToken();
  await db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  return t.token;
}

function appWith(opts: {
  mode: "true" | "false";
  bypassOnByok: boolean;
  limit: number;
  name?: string;
}): Hono<{ Variables: { db: DbClient } }> {
  process.env.PUBLIC_INSTANCE_MODE = opts.mode;
  const app = new Hono<{ Variables: { db: DbClient } }>();
  app.use("*", async (c, next) => {
    c.set("db", testDb.db);
    await next();
  });
  app.use(
    "*",
    rateLimit({
      name: opts.name ?? "test_limit",
      limit: opts.limit,
      windowSec: 60,
      bypassOnByok: opts.bypassOnByok,
    }),
  );
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("rate-limit middleware", () => {
  test("PUBLIC_INSTANCE_MODE=false: no enforcement", async () => {
    const app = appWith({ mode: "false", bypassOnByok: true, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("PUBLIC_INSTANCE_MODE=true: enforces under limit, 429 over", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 2 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r3 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    const body = (await r3.json()) as { error: string; retryAfterSec: number; name: string };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.name).toBe("test_limit");
    expect(r3.headers.get("Retry-After")).toBeTruthy();
  });

  test("BYOK header bypasses when bypassOnByok=true", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", {
      headers: { "X-Auth-Token": token, "X-User-Helius-Key": "user-key-xyz" },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("BYOK header does NOT bypass when bypassOnByok=false", async () => {
    const app = appWith({ mode: "true", bypassOnByok: false, limit: 1 });
    const token = await issueToken(testDb.db);
    const r1 = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const r2 = await app.request("/probe", {
      headers: { "X-Auth-Token": token, "X-User-Helius-Key": "user-key-xyz" },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  test("rate_bucket persists per name", async () => {
    const app = appWith({
      mode: "true",
      bypassOnByok: true,
      limit: 5,
      name: "specific_bucket",
    });
    const token = await issueToken(testDb.db);
    await app.request("/probe", { headers: { "X-Auth-Token": token } });
    const rows = await testDb.db
      .select()
      .from(authTokens)
      .where(eq(authTokens.token, token));
    const bucket = rows[0]!.rateBucket as Record<
      string,
      { windowStart: string; count: number }
    >;
    expect(bucket.specific_bucket?.count).toBe(1);
    expect(bucket.specific_bucket?.windowStart).toBeTruthy();
  });

  test("X-RateLimit-* headers on success", async () => {
    const app = appWith({ mode: "true", bypassOnByok: true, limit: 10 });
    const token = await issueToken(testDb.db);
    const r = await app.request("/probe", { headers: { "X-Auth-Token": token } });
    expect(r.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(r.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  test("two limits on same token use separate buckets", async () => {
    process.env.PUBLIC_INSTANCE_MODE = "true";
    const app = new Hono<{ Variables: { db: DbClient } }>();
    app.use("*", async (c, next) => {
      c.set("db", testDb.db);
      await next();
    });
    app.use(
      "/a",
      rateLimit({ name: "limit_a", limit: 1, windowSec: 60, bypassOnByok: false }),
    );
    app.get("/a", (c) => c.json({ ok: "a" }));
    app.use(
      "/b",
      rateLimit({ name: "limit_b", limit: 1, windowSec: 60, bypassOnByok: false }),
    );
    app.get("/b", (c) => c.json({ ok: "b" }));

    const token = await issueToken(testDb.db);
    const ra1 = await app.request("/a", { headers: { "X-Auth-Token": token } });
    const ra2 = await app.request("/a", { headers: { "X-Auth-Token": token } });
    const rb1 = await app.request("/b", { headers: { "X-Auth-Token": token } });
    expect(ra1.status).toBe(200);
    expect(ra2.status).toBe(429);
    expect(rb1.status).toBe(200); // separate bucket, fresh count
  });
});
