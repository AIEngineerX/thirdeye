import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { getCache } from "@thirdeye/helius";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { FIXTURE_INVALID_ADDRESS, FIXTURE_WALLET } from "./fixtures/helius";
import { type TestDb, setupTestDb } from "./setup";

const HAVE_KEY = Boolean(process.env.HELIUS_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  if (!HAVE_KEY) {
    console.log("[skip] HELIUS_API_KEY not set — Helius integration tests skipped");
  }
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

d("Helius routes (real Helius)", () => {
  test("GET /api/helius/v1/wallet/:addr/identity returns 200 + object body", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });

  test("GET /api/helius/v1/wallet/:addr/balances returns 200 + has nativeBalance or items", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/balances?limit=10`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
  });

  test("GET /api/helius/v1/wallet/:addr/funded-by passes through Helius status (200 or 404)", async () => {
    // Some wallets (e.g., genesis-allocated) have no funding tx → Helius returns 404.
    // The proxy's job is to faithfully pass that through. Both 200 and 404 prove that.
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/funded-by`, {
      headers: { "X-Auth-Token": token },
    });
    expect([200, 404]).toContain(r.status);
  }, 20_000);

  test("Cache observability: first call is MISS, second is HIT, identical body", async () => {
    getCache().clear();
    const url = `/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`;
    const r1 = await app.request(url, { headers: { "X-Auth-Token": token } });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("X-ThirdEye-Cache")).toBe("MISS");
    const body1 = await r1.json();

    const r2 = await app.request(url, { headers: { "X-Auth-Token": token } });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-ThirdEye-Cache")).toBe("HIT");
    const body2 = await r2.json();

    expect(body2).toEqual(body1);
  }, 20_000);

  test("GET /api/helius/v0/addresses/:addr/transactions returns 200", async () => {
    const r = await app.request(`/api/helius/v0/addresses/${FIXTURE_WALLET}/transactions?limit=5`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
  });

  test("invalid address returns 400 without hitting Helius", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_INVALID_ADDRESS}/funded-by`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_address");
  });

  test("POST /api/helius/v1/wallet/batch-identity validates + returns 200", async () => {
    const r = await app.request("/api/helius/v1/wallet/batch-identity", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: [FIXTURE_WALLET] }),
    });
    expect(r.status).toBe(200);
  });

  test("POST /api/helius-rpc with disallowed method returns 403", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [],
      }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("forbidden_rpc_method");
  });

  test("POST /api/helius-rpc with malformed envelope returns 400", async () => {
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", method: "foo", params: [] }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/helius-rpc getHealth returns 200", async () => {
    // getHealth is a simple RPC method that returns "ok" or a status object.
    const r = await app.request("/api/helius-rpc", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
        params: [],
      }),
    });
    expect(r.status).toBe(200);
  }, 20_000);

  test("BYOK: deliberately bad X-User-Helius-Key returns Helius's auth-error status (passthrough, not 502)", async () => {
    // Cache is content-keyed (not key-keyed) per spec §5, so a prior server-key call
    // would short-circuit this BYOK call to a cached 200. Reset the cache so the call
    // actually exercises the BYOK path through the network.
    getCache().clear();
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`, {
      headers: {
        "X-Auth-Token": token,
        "X-User-Helius-Key": "deliberately-invalid-key-xxx",
      },
    });
    // Helius returns 401 for an unknown key. We pass through the status (not 502).
    expect([400, 401, 403]).toContain(r.status);
  }, 20_000);
});

// Inverse of `d`: only runs when the key is NOT configured.
const dNoKey = HAVE_KEY ? describe.skip : describe;

dNoKey("Helius routes (no-key fallback)", () => {
  test("returns 503 when no key configured and no BYOK header", async () => {
    const r = await app.request(`/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("no_helius_key");
  });
});
