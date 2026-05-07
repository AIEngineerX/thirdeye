// rpc.ts has only one happy-path test (`getHealth` against real Helius);
// the validation branches that don't require Helius were untested. Cover:
//  - null body (empty string) → invalid_body
//  - non-JSON body → invalid_body
//  - jsonrpc 1.0 (handled by validateRpcEnvelope, integrated through route)
//  - denied method → forbidden
//
// These don't need the HELIUS_API_KEY because the rpc route validates
// before proxying.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
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

describe("POST /api/helius-rpc validation", () => {
  test("empty body → invalid_body 400", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: "",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_rpc_body");
  });

  test("non-JSON body → invalid_body 400", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: "not even close to json {{{",
    });
    expect(r.status).toBe(400);
  });

  test("jsonrpc 1.0 → invalid envelope 400", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "getBalance", params: [] }),
    });
    expect(r.status).toBe(400);
  });

  test("missing method → invalid envelope 400", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: [] }),
    });
    expect(r.status).toBe(400);
  });

  test("denied method requestAirdrop → 403 forbidden_rpc_method", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "requestAirdrop",
        params: ["someaddr", 1],
      }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("forbidden_rpc_method");
  });

  test("requires auth (no X-Auth-Token → 401)", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
    });
    expect(r.status).toBe(401);
  });
});
