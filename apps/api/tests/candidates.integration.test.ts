// Candidates routes: GET / (list) + POST /:address/promote.
//
// The Helius webhook fake server is set up identically to tracked-crud so
// resyncWebhook runs against a local stub — no real Helius calls are made.
// ST quality snapshot on promotion is best-effort; the test address will 404
// on ST (no trading history) which is the expected happy-path: the row still
// lands in tracked_wallets.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, candidateWallets, trackedWallets } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const ORIGINAL_ENV = { ...process.env };
let testDb: TestDb;
// biome-ignore lint/suspicious/noExplicitAny: Bun.serve return type narrowing varies across releases
let server: any;
let originalFetch: typeof globalThis.fetch;

interface FakeWebhook {
  webhookID: string;
  accountAddresses: string[];
}
const fakeStore = new Map<string, FakeWebhook>();

beforeAll(async () => {
  testDb = await setupTestDb();
  originalFetch = globalThis.fetch;

  // Local fake Helius webhook server — mirrors tracked-crud setup.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v0/webhooks") {
        const body = (await req.json().catch(() => ({}))) as {
          accountAddresses?: string[];
        };
        const id = `wh_cand_${fakeStore.size + 1}`;
        const w: FakeWebhook = { webhookID: id, accountAddresses: body.accountAddresses ?? [] };
        fakeStore.set(id, w);
        return Response.json(w);
      }
      if (req.method === "GET" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        const w = fakeStore.get(id);
        if (!w) return new Response("not found", { status: 404 });
        return Response.json(w);
      }
      if (req.method === "PUT" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        const w = fakeStore.get(id);
        if (!w) return new Response("not found", { status: 404 });
        const body = (await req.json().catch(() => ({}))) as { accountAddresses?: string[] };
        if (body.accountAddresses) w.accountAddresses = body.accountAddresses;
        return Response.json(w);
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        fakeStore.delete(id);
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl =
      input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const u = new URL(inputUrl);
    if (u.hostname === "api-mainnet.helius-rpc.com") {
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = String(port);
      return originalFetch(u.toString(), init);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || "fake-helius-key";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:65535";
  process.env.HELIUS_WEBHOOK_AUTH = "candidates-test-secret";
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  server.stop(true);
  await testDb.cleanup();
  process.env.HELIUS_API_KEY = ORIGINAL_ENV.HELIUS_API_KEY;
  process.env.PUBLIC_BASE_URL = ORIGINAL_ENV.PUBLIC_BASE_URL;
  process.env.HELIUS_WEBHOOK_AUTH = ORIGINAL_ENV.HELIUS_WEBHOOK_AUTH;
});

let token: string;

beforeEach(async () => {
  fakeStore.clear();
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, watches, watch_events, helius_webhooks, wallet_checks, wallets, token_scans, funders, intel_aggregates, tracked_wallets, smart_trades, candidate_wallets RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

// Valid base58 address with no ST trading history — ST returns 404 → quality
// null → still lands in tracked_wallets (best-effort snapshot).
const ADDR_A = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const ADDR_B = "So11111111111111111111111111111111111111112";

describe("GET /api/db/candidates", () => {
  test("returns unpromoted candidates, excludes promoted by default", async () => {
    await testDb.sql.unsafe(`
      INSERT INTO candidate_wallets (address, source, early_rate, src_pnl_all, buys_observed)
      VALUES
        ('${ADDR_A}', 'st_leaderboard', 0.7, 2000, 30),
        ('${ADDR_B}', 'st_leaderboard', 0.5, 1000, 20);
      UPDATE candidate_wallets SET promoted = true WHERE address = '${ADDR_B}';
    `);

    const r = await app.request("/api/db/candidates", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { address: string; promoted: boolean }[] };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.address).toBe(ADDR_A);
    expect(body.items[0]!.promoted).toBe(false);
  });

  test("includePromoted=true returns all candidates", async () => {
    await testDb.sql.unsafe(`
      INSERT INTO candidate_wallets (address, source, buys_observed)
      VALUES ('${ADDR_A}', 'st_leaderboard', 5), ('${ADDR_B}', 'st_leaderboard', 3);
      UPDATE candidate_wallets SET promoted = true WHERE address = '${ADDR_B}';
    `);

    const r = await app.request("/api/db/candidates?includePromoted=true", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { address: string }[] };
    expect(body.items.length).toBe(2);
  });

  test("empty list when no candidates seeded", async () => {
    const r = await app.request("/api/db/candidates", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });
});

describe("POST /api/db/candidates/:address/promote", () => {
  test("promote → tracked_wallets row exists + candidate marked promoted", async () => {
    await testDb.sql.unsafe(`
      INSERT INTO candidate_wallets (address, source, display_name, buys_observed)
      VALUES ('${ADDR_A}', 'st_leaderboard', 'Alpha Trader', 10);
    `);

    const r = await app.request(`/api/db/candidates/${ADDR_A}/promote`, {
      method: "POST",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { promoted: string };
    expect(body.promoted).toBe(ADDR_A);

    // tracked_wallets must have the row
    const tracked = await testDb.db
      .select()
      .from(trackedWallets)
      .where(eq(trackedWallets.address, ADDR_A));
    expect(tracked.length).toBe(1);
    expect(tracked[0]!.source).toBe("st_leaderboard");

    // candidate row must be marked promoted
    const cands = await testDb.db
      .select()
      .from(candidateWallets)
      .where(eq(candidateWallets.address, ADDR_A));
    expect(cands[0]!.promoted).toBe(true);
  });

  test("promote unknown address → 404 not_a_candidate", async () => {
    const r = await app.request(`/api/db/candidates/${ADDR_A}/promote`, {
      method: "POST",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("not_a_candidate");
  });

  test("promote invalid address → 400", async () => {
    const r = await app.request("/api/db/candidates/not-a-real-addr/promote", {
      method: "POST",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_address");
  });
});

describe("Auth guard", () => {
  test("GET without token → 401", async () => {
    const r = await app.request("/api/db/candidates");
    expect(r.status).toBe(401);
  });

  test("POST promote without token → 401", async () => {
    const r = await app.request(`/api/db/candidates/${ADDR_A}/promote`, { method: "POST" });
    expect(r.status).toBe(401);
  });
});
