import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { FIXTURE_WALLET } from "./fixtures/helius";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

describe("POST /api/helius/v1/wallet/batch-identity validation", () => {
  test("missing body returns invalid_body 400", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: "",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  test("body without addresses key returns 400", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(r.status).toBe(400);
  });

  test("addresses must be array (object rejected)", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: { 0: FIXTURE_WALLET } }),
    });
    expect(r.status).toBe(400);
  });

  test("empty addresses array rejected (1..100)", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { message: string };
    expect(body.message).toContain("1..100");
  });

  test("addresses array > 100 rejected", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: Array(101).fill(FIXTURE_WALLET) }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { message: string };
    expect(body.message).toContain("1..100");
  });

  test("non-string entry rejected as invalid_address", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [FIXTURE_WALLET, 123] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_address");
  });

  test("invalid base58 string rejected", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: ["not-a-real-addr"] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_address");
  });

  test("requires auth", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [FIXTURE_WALLET] }),
    });
    expect(r.status).toBe(401);
  });
});
