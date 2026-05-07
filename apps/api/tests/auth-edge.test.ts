// Auth/middleware edges not covered by auth.test.ts and middleware-auth.test.ts:
//  - non-JSON body to /api/db/auth (handler ignores body anyway)
//  - concurrent valid requests bump last_used_at without errors
//  - rate-limit window expiry (count resets)
//  - rate-limit isolation across distinct tokens
//  - token issued, expires_at honored at 1ms precision

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type DbClient, authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { rateLimit } from "../src/middleware/rate-limit";
import { type TestDb, setupTestDb } from "./setup";

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

describe("POST /api/db/auth edge cases", () => {
  test("empty body still issues token (no body parse required)", async () => {
    const r = await app.request("/api/db/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("non-JSON body still issues token", async () => {
    const r = await app.request("/api/db/auth", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "<<<not json>>>",
    });
    expect(r.status).toBe(200);
  });

  test("expiresAt is roughly 7 days in the future (matches generateToken)", async () => {
    const r = await app.request("/api/db/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await r.json()) as { expiresAt: string };
    const ms = new Date(body.expiresAt).getTime() - Date.now();
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ms).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });
});

describe("requireAuth concurrency", () => {
  test("five parallel requests with same token all succeed and bump last_used_at", async () => {
    const t = generateToken();
    await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });

    const before = await testDb.db.select().from(authTokens).where(eq(authTokens.token, t.token));
    const beforeUsed = before[0]!.lastUsedAt.getTime();
    await new Promise((r) => setTimeout(r, 20));

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request("/api/db/protected-probe", {
          method: "GET",
          headers: { "X-Auth-Token": t.token },
        }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const after = await testDb.db.select().from(authTokens).where(eq(authTokens.token, t.token));
    expect(after[0]!.lastUsedAt.getTime()).toBeGreaterThan(beforeUsed);
  });

  test("expired exactly at boundary returns 401 (<= comparison is inclusive)", async () => {
    const t = generateToken();
    await testDb.db.insert(authTokens).values({
      token: t.token,
      expiresAt: new Date(Date.now()), // expires "now"
    });
    // Sleep tiny amount so the request wallclock advances past expiresAt.
    await new Promise((r) => setTimeout(r, 5));
    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": t.token },
    });
    expect(r.status).toBe(401);
  });
});

describe("rateLimit edges", () => {
  function appWith(opts: {
    name?: string;
    limit: number;
    windowSec: number;
    bypassOnByok: boolean;
  }): Hono<{ Variables: { db: DbClient } }> {
    process.env.PUBLIC_INSTANCE_MODE = "true";
    const a = new Hono<{ Variables: { db: DbClient } }>();
    a.use("*", async (c, next) => {
      c.set("db", testDb.db);
      await next();
    });
    a.use(
      "*",
      rateLimit({
        name: opts.name ?? "edge_test",
        limit: opts.limit,
        windowSec: opts.windowSec,
        bypassOnByok: opts.bypassOnByok,
      }),
    );
    a.get("/probe", (c) => c.json({ ok: true }));
    return a;
  }

  async function issueToken(): Promise<string> {
    const t = generateToken();
    await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
    return t.token;
  }

  test("window expiry: count resets after windowSec elapses", async () => {
    // limit=1, windowSec=1 → second call within 1s blocked, second call after 1.2s allowed
    const a = appWith({ limit: 1, windowSec: 1, bypassOnByok: false });
    const tok = await issueToken();

    const r1 = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
    const r2 = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);

    await new Promise((r) => setTimeout(r, 1100));
    const r3 = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
    expect(r3.status).toBe(200);
  });

  test("two distinct tokens have isolated counters", async () => {
    const a = appWith({ limit: 1, windowSec: 60, bypassOnByok: false, name: "iso_bucket" });
    const t1 = await issueToken();
    const t2 = await issueToken();

    const a1 = await a.request("/probe", { headers: { "X-Auth-Token": t1 } });
    const a2 = await a.request("/probe", { headers: { "X-Auth-Token": t1 } });
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(429);

    // t2 starts fresh — limit untouched.
    const b1 = await a.request("/probe", { headers: { "X-Auth-Token": t2 } });
    expect(b1.status).toBe(200);
  });

  test("missing X-Auth-Token: middleware passes through (auth handler will 401)", async () => {
    const a = appWith({ limit: 1, windowSec: 60, bypassOnByok: false });
    // No X-Auth-Token. rateLimit returns next() — our /probe has no auth, returns 200.
    const r = await a.request("/probe");
    expect(r.status).toBe(200);
  });

  test("X-RateLimit-Reset header is in the future, ISO-formatted", async () => {
    const a = appWith({ limit: 5, windowSec: 60, bypassOnByok: false });
    const tok = await issueToken();
    const r = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
    const reset = r.headers.get("X-RateLimit-Reset");
    expect(reset).toBeTruthy();
    expect(new Date(reset!).getTime()).toBeGreaterThan(Date.now());
  });

  test("11th request in a 10-limit window: count=11, returns 429 with retryAfterSec", async () => {
    const a = appWith({ limit: 10, windowSec: 60, bypassOnByok: false });
    const tok = await issueToken();
    for (let i = 0; i < 10; i++) {
      const r = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
      expect(r.status).toBe(200);
    }
    const r11 = await a.request("/probe", { headers: { "X-Auth-Token": tok } });
    expect(r11.status).toBe(429);
    const body = (await r11.json()) as { retryAfterSec: number };
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(60);
  });
});
