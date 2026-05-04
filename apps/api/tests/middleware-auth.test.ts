import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { app } from "../src/index";
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

async function issueToken(): Promise<string> {
  const r = await app.request("/api/db/auth", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  return ((await r.json()) as { token: string }).token;
}

describe("X-Auth-Token middleware", () => {
  test("missing header → 401", async () => {
    const r = await app.request("/api/db/protected-probe", { method: "GET" });
    expect(r.status).toBe(401);
  });

  test("invalid token → 401", async () => {
    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": "not-a-real-token" },
    });
    expect(r.status).toBe(401);
  });

  test("valid token → 200 and bumps last_used_at", async () => {
    const token = await issueToken();
    const before = await testDb.db.select().from(authTokens).where(eq(authTokens.token, token));
    const beforeUsed = before[0]!.lastUsedAt.getTime();

    await new Promise((r) => setTimeout(r, 100));

    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);

    const after = await testDb.db.select().from(authTokens).where(eq(authTokens.token, token));
    const afterUsed = after[0]!.lastUsedAt.getTime();
    expect(afterUsed).toBeGreaterThan(beforeUsed);
  });

  test("expired token → 401", async () => {
    const token = await issueToken();
    await testDb.db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.token, token));

    const r = await app.request("/api/db/protected-probe", {
      method: "GET",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(401);
  });
});
