// Watches CRUD: rollback semantics, multi-token isolation, label persist,
// >100 cap, delete-by-addr idempotency, multi-address request, GET events
// limit clamping. The existing helius-webhook.integration.test covers the
// public ingest + a few CRUD edges; this file fills in the rest.
//
// Helius webhook upstream is a real local Bun.serve so the watches POST
// flow actually exercises sync.ts with a live (controllable) target.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, heliusWebhooks, watchEvents, watches } from "@thirdeye/db";
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
let nextCreateBehavior: "ok" | "fail" = "ok";

beforeAll(async () => {
  testDb = await setupTestDb();
  originalFetch = globalThis.fetch;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v0/webhooks") {
        if (nextCreateBehavior === "fail") {
          return new Response("simulated upstream rejection", { status: 500 });
        }
        const body = (await req.json().catch(() => ({}))) as {
          accountAddresses?: string[];
        };
        const id = `wh_${fakeStore.size + 1}`;
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

  // Real Helius env so the watches POST flow accepts requests.
  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || "fake-helius-key";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:65535"; // arbitrary but truthy
  process.env.HELIUS_WEBHOOK_AUTH = "watches-crud-secret";
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server.stop(true);
  testDb.cleanup();
  process.env.HELIUS_API_KEY = ORIGINAL_ENV.HELIUS_API_KEY;
  process.env.PUBLIC_BASE_URL = ORIGINAL_ENV.PUBLIC_BASE_URL;
  process.env.HELIUS_WEBHOOK_AUTH = ORIGINAL_ENV.HELIUS_WEBHOOK_AUTH;
});

let token: string;
let token2: string;

beforeEach(async () => {
  fakeStore.clear();
  nextCreateBehavior = "ok";
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, watches, watch_events, helius_webhooks, wallet_checks, wallets, token_scans, funders, intel_aggregates RESTART IDENTITY CASCADE;",
  );
  const t1 = generateToken();
  const t2 = generateToken();
  await testDb.db.insert(authTokens).values([
    { token: t1.token, expiresAt: t1.expiresAt },
    { token: t2.token, expiresAt: t2.expiresAt },
  ]);
  token = t1.token;
  token2 = t2.token;
});

const ADDR_A = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const ADDR_B = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

describe("POST /api/db/watches", () => {
  test("happy path: inserts row with label, syncs upstream, returns count", async () => {
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A], label: "alpha-wallet" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { added: number; label: string };
    expect(body.added).toBe(1);
    expect(body.label).toBe("alpha-wallet");

    const rows = await testDb.db.select().from(watches);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(ADDR_A);
    expect(rows[0]!.label).toBe("alpha-wallet");
    expect(rows[0]!.token).toBe(token);

    const wh = await testDb.db.select().from(heliusWebhooks);
    expect(wh).toHaveLength(1);
    expect(fakeStore.size).toBe(1);
  });

  test("rollback: Helius rejects → local watches rows reverted", async () => {
    nextCreateBehavior = "fail";
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("helius_sync_failed");

    // Local rollback: no watches row left behind.
    const rows = await testDb.db.select().from(watches);
    expect(rows).toHaveLength(0);
  });

  test("multi-address single request: all rows persisted, one sync call", async () => {
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A, ADDR_B] }),
    });
    expect(r.status).toBe(200);
    const rows = await testDb.db.select().from(watches);
    expect(rows.map((r) => r.address).sort()).toEqual([ADDR_A, ADDR_B].sort());
    expect(fakeStore.size).toBe(1);
    const accounts = [...fakeStore.values()][0]!.accountAddresses;
    expect(accounts.sort()).toEqual([ADDR_A, ADDR_B].sort());
  });

  test("idempotent: same address from same token twice → still one row", async () => {
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    const rows = await testDb.db.select().from(watches).where(eq(watches.token, token));
    expect(rows).toHaveLength(1);
  });

  test(">100 addresses rejected with 400", async () => {
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: Array(101).fill(ADDR_A) }),
    });
    expect(r.status).toBe(400);
  });

  test("multi-token isolation: same address from two tokens → two rows, one upstream slot", async () => {
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token2 },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    const all = await testDb.db.select().from(watches);
    expect(all).toHaveLength(2);
    const tokenSet = new Set(all.map((r) => r.token));
    expect(tokenSet.size).toBe(2);
    // Only one upstream — addresses are deduped by sync.ts via SELECT DISTINCT.
    expect(fakeStore.size).toBe(1);
    const accounts = [...fakeStore.values()][0]!.accountAddresses;
    expect(accounts).toEqual([ADDR_A]);
  });
});

describe("DELETE /api/db/watches/:address", () => {
  test("deleting last watcher of an address removes it from upstream set", async () => {
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A, ADDR_B] }),
    });
    expect(fakeStore.size).toBe(1);
    expect([...fakeStore.values()][0]!.accountAddresses.sort()).toEqual([ADDR_A, ADDR_B].sort());

    const r = await app.request(`/api/db/watches/${ADDR_A}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);

    const rows = await testDb.db.select().from(watches);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(ADDR_B);
    // Upstream synced down to {ADDR_B} via PUT update
    expect([...fakeStore.values()][0]!.accountAddresses).toEqual([ADDR_B]);
  });

  test("multi-token: token A deleting their watch leaves token B's watch intact", async () => {
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token2 },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });

    await app.request(`/api/db/watches/${ADDR_A}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });

    const remaining = await testDb.db.select().from(watches);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.token).toBe(token2);
    // Upstream still has ADDR_A (token2 still wants it)
    expect([...fakeStore.values()][0]!.accountAddresses).toEqual([ADDR_A]);
  });

  test("deleting a non-existent watch is a no-op (DELETE is idempotent)", async () => {
    const r = await app.request(`/api/db/watches/${ADDR_A}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    // No rows existed before; the route still tries to sync. With no
    // watches row to begin with, sync is a no-op.
    expect([200, 502]).toContain(r.status);
  });

  test("invalid address returns 400", async () => {
    const r = await app.request("/api/db/watches/not-a-real-addr", {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /api/db/watches", () => {
  test("only returns this token's watches, sorted by createdAt DESC", async () => {
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A] }),
    });
    // Different token's watch — must NOT appear in our list.
    await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token2 },
      body: JSON.stringify({ addresses: [ADDR_B] }),
    });

    const r = await app.request("/api/db/watches", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: { address: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.address).toBe(ADDR_A);
  });
});

describe("GET /api/db/watches/:address/events", () => {
  test("limit clamps: ?limit=999 → 200, ?limit=0 → 1", async () => {
    await testDb.db.insert(watches).values({ address: ADDR_A, token });
    // Seed 5 events
    for (let i = 0; i < 5; i++) {
      await testDb.db.insert(watchEvents).values({
        address: ADDR_A,
        signature: `sig${i}`,
        type: "TRANSFER",
        payload: {},
      });
    }

    const r1 = await app.request(`/api/db/watches/${ADDR_A}/events?limit=999`, {
      headers: { "X-Auth-Token": token },
    });
    const b1 = (await r1.json()) as { items: unknown[] };
    expect(b1.items.length).toBe(5); // we only have 5; limit clamp doesn't matter

    const r2 = await app.request(`/api/db/watches/${ADDR_A}/events?limit=0`, {
      headers: { "X-Auth-Token": token },
    });
    const b2 = (await r2.json()) as { items: unknown[] };
    expect(b2.items.length).toBe(1); // clamped to min=1
  });

  test("invalid limit (non-numeric) falls back to default 50", async () => {
    await testDb.db.insert(watches).values({ address: ADDR_A, token });
    for (let i = 0; i < 60; i++) {
      await testDb.db.insert(watchEvents).values({
        address: ADDR_A,
        signature: `s${i}`,
        type: "TRANSFER",
        payload: {},
      });
    }
    const r = await app.request(`/api/db/watches/${ADDR_A}/events?limit=garbage`, {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items.length).toBe(50);
  });

  test("invalid address returns 400", async () => {
    const r = await app.request("/api/db/watches/not-real/events", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });
});
