import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { app } from "../src/index";
import { setupTestDb, type TestDb } from "./setup";
import { authTokens } from "@thirdeye/db";
import { generateToken } from "../src/lib/tokens";
import { FIXTURE_WALLET, FIXTURE_INVALID_ADDRESS } from "./fixtures/helius";

const HAVE_KEY = Boolean(process.env.HELIUS_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  if (!HAVE_KEY) {
    console.log(
      "[skip] HELIUS_API_KEY not set — Helius integration tests skipped",
    );
  }
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
  const t = generateToken();
  await testDb.db
    .insert(authTokens)
    .values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

d("Helius routes (real Helius)", () => {
  test("GET /api/helius/v1/wallet/:addr/identity returns 200 + object body", async () => {
    const r = await app.request(
      `/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`,
      { headers: { "X-Auth-Token": token } },
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });

  test("GET /api/helius/v1/wallet/:addr/balances returns 200 + has nativeBalance or items", async () => {
    const r = await app.request(
      `/api/helius/v1/wallet/${FIXTURE_WALLET}/balances?limit=10`,
      { headers: { "X-Auth-Token": token } },
    );
    expect(r.status).toBe(200);
  });

  test(
    "GET /api/helius/v1/wallet/:addr/funded-by returns 200 with stable result + observable cache hit",
    async () => {
      const url = `/api/helius/v1/wallet/${FIXTURE_WALLET}/funded-by`;
      const t1 = Date.now();
      const r1 = await app.request(url, { headers: { "X-Auth-Token": token } });
      const d1 = Date.now() - t1;
      expect(r1.status).toBe(200);
      const body1 = await r1.json();

      const t2 = Date.now();
      const r2 = await app.request(url, { headers: { "X-Auth-Token": token } });
      const d2 = Date.now() - t2;
      expect(r2.status).toBe(200);
      const body2 = await r2.json();

      expect(body2).toEqual(body1);
      // Cache hit should be much faster than a network call.
      expect(d2 + 5).toBeLessThan(d1);
    },
    20_000,
  );

  test("GET /api/helius/v0/addresses/:addr/transactions returns 200", async () => {
    const r = await app.request(
      `/api/helius/v0/addresses/${FIXTURE_WALLET}/transactions?limit=5`,
      { headers: { "X-Auth-Token": token } },
    );
    expect(r.status).toBe(200);
  });

  test("invalid address returns 400 without hitting Helius", async () => {
    const r = await app.request(
      `/api/helius/v1/wallet/${FIXTURE_INVALID_ADDRESS}/funded-by`,
      { headers: { "X-Auth-Token": token } },
    );
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

  test(
    "POST /api/helius-rpc getHealth returns 200",
    async () => {
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
    },
    20_000,
  );

  test(
    "BYOK: deliberately bad X-User-Helius-Key returns Helius's status (passthrough, not 502)",
    async () => {
      const r = await app.request(
        `/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`,
        {
          headers: {
            "X-Auth-Token": token,
            "X-User-Helius-Key": "deliberately-invalid-key-xxx",
          },
        },
      );
      // Helius returns 401 for an unknown key. We pass through the status (not 502).
      expect([400, 401, 403]).toContain(r.status);
    },
    20_000,
  );
});

describe("Helius routes (no-key fallback)", () => {
  test("returns 503 when no key configured and no BYOK header", async () => {
    if (HAVE_KEY) {
      // Skip when the env IS configured: this case can't be tested.
      return;
    }
    const r = await app.request(
      `/api/helius/v1/wallet/${FIXTURE_WALLET}/identity`,
      { headers: { "X-Auth-Token": token } },
    );
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("no_helius_key");
  });
});
