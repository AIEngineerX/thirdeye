import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/index";
import { setupTestDb, type TestDb } from "./setup";
import { authTokens } from "@thirdeye/db";
import { eq } from "drizzle-orm";

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

describe("POST /api/db/auth", () => {
  test("issues a token and persists it", async () => {
    const res = await app.request("/api/db/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };

    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await testDb.db
      .select()
      .from(authTokens)
      .where(eq(authTokens.token, body.token));
    expect(rows).toHaveLength(1);
  });

  test("two requests issue distinct tokens, both persisted", async () => {
    const r1 = await app.request("/api/db/auth", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const r2 = await app.request("/api/db/auth", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    const t1 = ((await r1.json()) as { token: string }).token;
    const t2 = ((await r2.json()) as { token: string }).token;
    expect(t1).not.toBe(t2);

    const rows = await testDb.db.select().from(authTokens);
    expect(rows).toHaveLength(2);
  });
});
