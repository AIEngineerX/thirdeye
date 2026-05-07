import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const VALID_SIG =
  "5j3z1jzVbGJZqxqNk5w7pKdRQjE3iNZL3Lp1qXFkBQXTYzkr5sKiJq7QwZqXn8z2vqJWTpZ4rHsPXCrK9F6vXwAB";

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

describe("POST /api/helius/v0/transactions validation", () => {
  test("missing body returns 400", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: "",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  test("body without transactions key rejected", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ sigs: [VALID_SIG] }),
    });
    expect(r.status).toBe(400);
  });

  test("transactions must be array", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: VALID_SIG }),
    });
    expect(r.status).toBe(400);
  });

  test("empty transactions array rejected (1..100)", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { message: string };
    expect(body.message).toContain("1..100");
  });

  test("> 100 signatures rejected", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: Array(101).fill(VALID_SIG) }),
    });
    expect(r.status).toBe(400);
  });

  test("non-string signature rejected", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [VALID_SIG, 12345] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { message: string };
    expect(body.message).toContain("non-string");
  });

  test("signature too short rejected", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: ["short"] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("Invalid signature");
  });

  test("signature too long rejected", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: ["5".repeat(89)] }),
    });
    expect(r.status).toBe(400);
  });

  test("signature with invalid base58 char (0/O/I/l) rejected", async () => {
    // 87 chars (in valid range) but contains '0' which is not in base58 alphabet
    const bad = `${"5".repeat(86)}0`;
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [bad] }),
    });
    expect(r.status).toBe(400);
  });

  test("requires auth", async () => {
    const r = await app.request("/api/helius/v0/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [VALID_SIG] }),
    });
    expect(r.status).toBe(401);
  });
});
