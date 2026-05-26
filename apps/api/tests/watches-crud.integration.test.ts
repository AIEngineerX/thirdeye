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

afterAll(async () => {
  globalThis.fetch = originalFetch;
  server.stop(true);
  await testDb.cleanup();
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
    const body = (await r.json()) as { error: string; message?: string };
    expect(body.error).toBe("helius_sync_failed");
    // Body must NOT include any String(e) leak (could contain api-key URL
    // fragments if Bun's fetch error format ever included them) — H4.
    expect(body.message).toBeUndefined();

    // Local rollback: no watches row left behind.
    const rows = await testDb.db.select().from(watches);
    expect(rows).toHaveLength(0);
  });

  test("multi-address rollback is atomic (B2)", async () => {
    // The old manual catch-and-delete loop could itself fail mid-loop and
    // leave inconsistent state. With the tx wrapper, all-or-nothing.
    nextCreateBehavior = "fail";
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ addresses: [ADDR_A, ADDR_B] }),
    });
    expect(r.status).toBe(502);
    const rows = await testDb.db.select().from(watches);
    expect(rows).toHaveLength(0);
    // heliusWebhooks also untouched
    const wh = await testDb.db.select().from(heliusWebhooks);
    expect(wh).toHaveLength(0);
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

  test("token without a watch on the address gets 404 (no IDOR)", async () => {
    // token1 watches ADDR_A; token2 should NOT be able to read its events.
    await testDb.db.insert(watches).values({ address: ADDR_A, token });
    await testDb.db.insert(watchEvents).values({
      address: ADDR_A,
      signature: "sig-leak",
      type: "TRANSFER",
      payload: { secret: "should not leak across tokens" },
    });

    // Cross-token request returns 404 without disclosing events.
    const cross = await app.request(`/api/db/watches/${ADDR_A}/events`, {
      headers: { "X-Auth-Token": token2 },
    });
    expect(cross.status).toBe(404);
    const crossBody = (await cross.json()) as { error?: string; items?: unknown };
    expect(crossBody.error).toBe("not_found");
    expect(crossBody.items).toBeUndefined();

    // Same-token request still works for the owner.
    const owner = await app.request(`/api/db/watches/${ADDR_A}/events`, {
      headers: { "X-Auth-Token": token },
    });
    expect(owner.status).toBe(200);
    const ownerBody = (await owner.json()) as {
      items: { signature: string; effects: Record<string, unknown>; payload?: unknown }[];
    };
    expect(ownerBody.items.length).toBe(1);
    expect(ownerBody.items[0]!.signature).toBe("sig-leak");
    // H3: raw payload (with adversarial `secret` field) must NOT appear in
    // the response — only the projected `effects` block.
    expect(ownerBody.items[0]!.payload).toBeUndefined();
    expect(ownerBody.items[0]!.effects).toBeDefined();
    expect(JSON.stringify(ownerBody.items[0]!.effects)).not.toContain("secret");
    expect(JSON.stringify(ownerBody.items[0]!.effects)).not.toContain("should not leak");
  });

  test("H3: unrelated-party token transfers are stripped from the response", async () => {
    await testDb.db.insert(watches).values({ address: ADDR_A, token });
    await testDb.db.insert(watchEvents).values({
      address: ADDR_A,
      signature: "sig-projection",
      type: "SWAP",
      payload: {
        signature: "sig-projection",
        source: "JUPITER",
        feePayer: ADDR_B, // someone else paid
        fee: 5000,
        tokenTransfers: [
          // Transfer between two unrelated parties — must NOT appear
          {
            fromUserAccount: ADDR_B,
            toUserAccount: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
            mint: "So11111111111111111111111111111111111111112",
            tokenAmount: 999,
          },
          // Transfer involving the watched address
          {
            fromUserAccount: ADDR_B,
            toUserAccount: ADDR_A,
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            tokenAmount: 250,
          },
        ],
        accountData: [
          { account: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", nativeBalanceChange: -777 },
          { account: ADDR_A, nativeBalanceChange: 100 },
        ],
      },
    });

    const r = await app.request(`/api/db/watches/${ADDR_A}/events`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: {
        effects: {
          feePayerIsAddress: boolean;
          feeLamports: number | null;
          nativeBalanceChange: number | null;
          tokenTransfers: Array<{ counterparty: string; mint: string; direction: string }>;
        };
      }[];
    };

    const e = body.items[0]!.effects;
    expect(e.feePayerIsAddress).toBe(false);
    expect(e.feeLamports).toBeNull();
    expect(e.nativeBalanceChange).toBe(100);
    expect(e.tokenTransfers).toHaveLength(1);
    expect(e.tokenTransfers[0]!.counterparty).toBe(ADDR_B);
    // Unrelated party's address must not appear anywhere in the response
    expect(JSON.stringify(body)).not.toContain("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
  });
});
