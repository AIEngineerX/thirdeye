// Tracked wallets CRUD: add, list, delete, invalid-address rejection.
//
// Helius webhook upstream is a real local Bun.serve (same redirect pattern as
// watches-crud.integration.test.ts) so syncHeliusWebhook exercises real code
// against a controllable fake — no real Helius requests are made.
//
// Solana Tracker IS called live on the add path when SOLANATRACKER_API_KEY is
// set. A historyless test address returns 404 → snapshot null → wallet is
// added with null quality fields. This is expected and intentional per spec.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, trackedWallets } from "@thirdeye/db";
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

  // Local fake Helius webhook server — intercepts POST/GET/PUT/DELETE on
  // /v0/webhooks. No requests ever leave the machine.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v0/webhooks") {
        const body = (await req.json().catch(() => ({}))) as {
          accountAddresses?: string[];
        };
        const id = `wh_tracked_${fakeStore.size + 1}`;
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

  // Redirect all Helius API calls to the local fake server.
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

  // Set all three required env vars so resyncWebhook runs (against fake server).
  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || "fake-helius-key";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:65535"; // arbitrary but truthy
  process.env.HELIUS_WEBHOOK_AUTH = "tracked-crud-secret";
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

beforeEach(async () => {
  fakeStore.clear();
  // TRUNCATE all tables that watches-crud truncates, plus tracked_wallets and
  // smart_trades (which has a FK-like dependency via tracked wallet addresses).
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, watches, watch_events, helius_webhooks, wallet_checks, wallets, token_scans, funders, intel_aggregates, tracked_wallets, smart_trades RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

// A valid base58 Solana address (44 chars) that has no trading history on
// Solana Tracker — ST will 404 → snapshot null → wallet added with null quality.
const ADDR = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";

describe("POST /api/db/tracked", () => {
  test("add → list shows it (address + label)", async () => {
    const h = { "X-Auth-Token": token, "Content-Type": "application/json" };

    const add = await app.request("/api/db/tracked", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ address: ADDR, label: "alpha" }),
    });
    expect(add.status).toBe(200);
    const addBody = (await add.json()) as { added: number; address: string; label: string | null };
    expect(addBody.added).toBe(1);
    expect(addBody.address).toBe(ADDR);
    expect(addBody.label).toBe("alpha");

    const list = await app.request("/api/db/tracked", { headers: { "X-Auth-Token": token } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      items: { address: string; label: string | null }[];
    };
    expect(listBody.items.some((w) => w.address === ADDR && w.label === "alpha")).toBe(true);
  });

  test("invalid address → 400", async () => {
    const r = await app.request("/api/db/tracked", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ address: "not-a-real-addr" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_address");
  });

  test("missing address → 400", async () => {
    const r = await app.request("/api/db/tracked", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "no-addr" }),
    });
    expect(r.status).toBe(400);
  });

  test("add persists row in DB", async () => {
    await app.request("/api/db/tracked", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ address: ADDR, label: "persist-check" }),
    });
    const rows = await testDb.db.select().from(trackedWallets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(ADDR);
    expect(rows[0]!.label).toBe("persist-check");
    expect(rows[0]!.source).toBe("manual");
  });

  test("idempotent: adding same address twice updates label, keeps one row", async () => {
    const h = { "X-Auth-Token": token, "Content-Type": "application/json" };
    await app.request("/api/db/tracked", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ address: ADDR, label: "first" }),
    });
    await app.request("/api/db/tracked", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ address: ADDR, label: "second" }),
    });
    const rows = await testDb.db.select().from(trackedWallets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("second");
  });
});

describe("DELETE /api/db/tracked/:address", () => {
  test("delete → list empty", async () => {
    const h = { "X-Auth-Token": token, "Content-Type": "application/json" };

    // Add first
    const add = await app.request("/api/db/tracked", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ address: ADDR, label: "to-remove" }),
    });
    expect(add.status).toBe(200);

    // Delete
    const del = await app.request(`/api/db/tracked/${ADDR}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { removed: number };
    expect(delBody.removed).toBe(1);

    // List is now empty
    const list2 = await app.request("/api/db/tracked", {
      headers: { "X-Auth-Token": token },
    });
    const list2Body = (await list2.json()) as { items: unknown[] };
    expect(list2Body.items.length).toBe(0);
  });

  test("invalid address → 400", async () => {
    const r = await app.request("/api/db/tracked/not-a-real-addr", {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });

  test("deleting non-existent address is a no-op (idempotent)", async () => {
    const r = await app.request(`/api/db/tracked/${ADDR}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
  });
});

describe("GET /api/db/tracked", () => {
  test("empty list when nothing added", async () => {
    const r = await app.request("/api/db/tracked", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  test("full round-trip: add → list → remove → list", async () => {
    const h = { "X-Auth-Token": token, "Content-Type": "application/json" };

    const add = await app.request("/api/db/tracked", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ address: ADDR, label: "alpha" }),
    });
    expect(add.status).toBe(200);

    const list = await app.request("/api/db/tracked", { headers: { "X-Auth-Token": token } });
    const listBody = (await list.json()) as {
      items: { address: string; label: string | null }[];
    };
    expect(listBody.items.some((w) => w.address === ADDR && w.label === "alpha")).toBe(true);

    const del = await app.request(`/api/db/tracked/${ADDR}`, {
      method: "DELETE",
      headers: { "X-Auth-Token": token },
    });
    expect(del.status).toBe(200);

    const list2 = await app.request("/api/db/tracked", { headers: { "X-Auth-Token": token } });
    const list2Body = (await list2.json()) as { items: unknown[] };
    expect(list2Body.items.length).toBe(0);
  });

  test("returns numeric winRate/roi/realizedPnlUsd (null when no quality snapshot)", async () => {
    await app.request("/api/db/tracked", {
      method: "POST",
      headers: { "X-Auth-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ address: ADDR }),
    });
    const r = await app.request("/api/db/tracked", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as {
      items: {
        address: string;
        winRate: number | null;
        realizedPnlUsd: number | null;
        roi: number | null;
        tokensTraded: number | null;
        addedAt: string;
      }[];
    };
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.address).toBe(ADDR);
    // ST 404 on unknown address → quality null → these are null
    expect(item.winRate === null || typeof item.winRate === "number").toBe(true);
    expect(item.realizedPnlUsd === null || typeof item.realizedPnlUsd === "number").toBe(true);
    expect(item.roi === null || typeof item.roi === "number").toBe(true);
    // addedAt must be a valid ISO timestamp
    expect(new Date(item.addedAt).getTime()).toBeGreaterThan(0);
  });
});

describe("Auth guard", () => {
  test("GET without token → 401", async () => {
    const r = await app.request("/api/db/tracked");
    expect(r.status).toBe(401);
  });

  test("POST without token → 401", async () => {
    const r = await app.request("/api/db/tracked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: ADDR }),
    });
    expect(r.status).toBe(401);
  });

  test("DELETE without token → 401", async () => {
    const r = await app.request(`/api/db/tracked/${ADDR}`, { method: "DELETE" });
    expect(r.status).toBe(401);
  });
});
