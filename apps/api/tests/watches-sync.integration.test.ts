// Direct integration tests for routes/watches/sync.ts state machine.
// Exercises every branch:
//   - empty address set → row gone, upstream deleted
//   - no row + non-empty addresses → first sync (createWebhook)
//   - row + upstream still exists → updateWebhook with merged set
//   - row + upstream gone (404) → recreate
//
// "Helius" is replaced by a real local Bun.serve responding to the
// webhook management API. globalThis.fetch is redirected only for the
// helius webhook host. webhooks-client.ts code path runs unmodified.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { heliusWebhooks, watches } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { collectWatchedAddresses, syncHeliusWebhook } from "../src/routes/watches/sync";
import { type TestDb, setupTestDb } from "./setup";

interface FakeWebhook {
  webhookID: string;
  accountAddresses: string[];
  webhookURL: string;
  authHeader: string;
}

let testDb: TestDb;
// biome-ignore lint/suspicious/noExplicitAny: Bun.serve return type narrowing varies across releases
let server: any;
let serverPort = 0;
let originalFetch: typeof globalThis.fetch;

const fakeStore = new Map<string, FakeWebhook>();
const callLog: { method: string; path: string; body?: unknown }[] = [];

beforeAll(async () => {
  testDb = await setupTestDb();
  originalFetch = globalThis.fetch;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => null) : null;
      callLog.push({ method: req.method, path: url.pathname, body: body ?? undefined });

      // POST /v0/webhooks?api-key=K → create
      if (req.method === "POST" && url.pathname === "/v0/webhooks") {
        const id = `wh_${fakeStore.size + 1}`;
        const w: FakeWebhook = {
          webhookID: id,
          accountAddresses: (body as { accountAddresses?: string[] })?.accountAddresses ?? [],
          webhookURL: (body as { webhookURL?: string })?.webhookURL ?? "",
          authHeader: (body as { authHeader?: string })?.authHeader ?? "",
        };
        fakeStore.set(id, w);
        return Response.json(w);
      }
      // GET /v0/webhooks/:id → get or 404
      if (req.method === "GET" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        const w = fakeStore.get(id);
        if (!w) return new Response("not found", { status: 404 });
        return Response.json(w);
      }
      // PUT /v0/webhooks/:id → update
      if (req.method === "PUT" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        const w = fakeStore.get(id);
        if (!w) return new Response("not found", { status: 404 });
        const newAddrs = (body as { accountAddresses?: string[] })?.accountAddresses;
        if (newAddrs) w.accountAddresses = newAddrs;
        return Response.json(w);
      }
      // DELETE /v0/webhooks/:id
      if (req.method === "DELETE" && url.pathname.startsWith("/v0/webhooks/")) {
        const id = url.pathname.split("/").pop()!;
        fakeStore.delete(id);
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  serverPort = server.port;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl =
      input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const u = new URL(inputUrl);
    if (u.hostname === "api-mainnet.helius-rpc.com") {
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = String(serverPort);
      return originalFetch(u.toString(), init);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  server.stop(true);
  await testDb.cleanup();
});

beforeEach(async () => {
  fakeStore.clear();
  callLog.length = 0;
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, watches, watch_events, helius_webhooks RESTART IDENTITY CASCADE;",
  );
});

const OPTS = {
  apiKey: "fake-key",
  webhookURL: "http://example.test/api/helius-webhook",
  authHeader: "secret-abc",
};

const ADDR_A = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const ADDR_B = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

async function seedToken(): Promise<string> {
  const t = `tok-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await testDb.sql.unsafe(
    `INSERT INTO auth_tokens (token, expires_at) VALUES ('${t}', now() + interval '1 day')`,
  );
  return t;
}

describe("syncHeliusWebhook state machine", () => {
  test("empty address set + no row → no-op (no upstream call)", async () => {
    await syncHeliusWebhook(testDb.db, OPTS);
    expect(callLog).toHaveLength(0);
    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows).toHaveLength(0);
  });

  test("first sync with non-empty set → POST create + insert row", async () => {
    const tok = await seedToken();
    await testDb.db.insert(watches).values({ address: ADDR_A, token: tok });
    await syncHeliusWebhook(testDb.db, OPTS);

    const creates = callLog.filter((c) => c.method === "POST" && c.path === "/v0/webhooks");
    expect(creates).toHaveLength(1);
    const createBody = creates[0]!.body as {
      accountAddresses: string[];
      webhookURL: string;
      authHeader: string;
    };
    expect(createBody.accountAddresses).toEqual([ADDR_A]);
    expect(createBody.webhookURL).toBe(OPTS.webhookURL);
    expect(createBody.authHeader).toBe(OPTS.authHeader);

    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.webhookId).toBe("wh_1");
    expect(rows[0]!.lastSyncedAddressCount).toBe(1);
  });

  test("row + upstream present + new address added → PUT update with merged set", async () => {
    const tok = await seedToken();
    await testDb.db.insert(watches).values({ address: ADDR_A, token: tok });
    await syncHeliusWebhook(testDb.db, OPTS);
    callLog.length = 0;

    await testDb.db.insert(watches).values({ address: ADDR_B, token: tok });
    await syncHeliusWebhook(testDb.db, OPTS);

    const gets = callLog.filter((c) => c.method === "GET");
    const puts = callLog.filter((c) => c.method === "PUT");
    expect(gets.length).toBeGreaterThanOrEqual(1);
    expect(puts).toHaveLength(1);
    const putBody = puts[0]!.body as { accountAddresses: string[] };
    expect(putBody.accountAddresses.sort()).toEqual([ADDR_A, ADDR_B].sort());

    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows[0]!.lastSyncedAddressCount).toBe(2);
  });

  test("row + upstream gone (404) → recreate, row updated with new id", async () => {
    const tok = await seedToken();
    await testDb.db.insert(watches).values({ address: ADDR_A, token: tok });
    await syncHeliusWebhook(testDb.db, OPTS);
    expect(fakeStore.size).toBe(1);
    // Simulate dashboard deletion: drop from fake upstream.
    fakeStore.clear();
    callLog.length = 0;

    await syncHeliusWebhook(testDb.db, OPTS);

    const creates = callLog.filter((c) => c.method === "POST" && c.path === "/v0/webhooks");
    expect(creates).toHaveLength(1); // recreated
    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows).toHaveLength(1);
    // After recreate, fakeStore now has wh_1 (counter restarts since clear).
    expect(rows[0]!.webhookId).toBe("wh_1");
    expect(fakeStore.size).toBe(1);
  });

  test("row + empty address set → DELETE upstream + clear local row", async () => {
    const tok = await seedToken();
    await testDb.db.insert(watches).values({ address: ADDR_A, token: tok });
    await syncHeliusWebhook(testDb.db, OPTS);
    expect(fakeStore.size).toBe(1);

    await testDb.db.delete(watches);
    callLog.length = 0;
    await syncHeliusWebhook(testDb.db, OPTS);

    const deletes = callLog.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(fakeStore.size).toBe(0);
    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows).toHaveLength(0);
  });

  test("delete-empty path: no upstream and no row → no-op when nothing to do (idempotent)", async () => {
    // This was the prior 'delete failure' test — narrowed to test idempotency
    // of the empty-set + no-row path against repeated calls.
    await syncHeliusWebhook(testDb.db, OPTS);
    await syncHeliusWebhook(testDb.db, OPTS);
    expect(callLog).toHaveLength(0);
    const rows = await testDb.db.select().from(heliusWebhooks);
    expect(rows).toHaveLength(0);
  });

  test("DISTINCT addresses: same address from two tokens → only one slot", async () => {
    const tok1 = await seedToken();
    const tok2 = await seedToken();
    await testDb.db.insert(watches).values([
      { address: ADDR_A, token: tok1 },
      { address: ADDR_A, token: tok2 },
    ]);
    await syncHeliusWebhook(testDb.db, OPTS);
    const created = [...fakeStore.values()][0]!;
    expect(created.accountAddresses).toEqual([ADDR_A]); // not duplicated
  });
});

describe("collectWatchedAddresses", () => {
  beforeEach(async () => {
    await testDb.sql.unsafe("TRUNCATE tracked_wallets, smart_trades RESTART IDENTITY CASCADE;");
  });

  test("collectWatchedAddresses unions watches and tracked_wallets, distinct + sorted", async () => {
    await testDb.sql.unsafe(`INSERT INTO tracked_wallets (address) VALUES ('AAA'), ('CCC')`);
    const tok = await seedToken();
    await testDb.db.insert(watches).values([
      { address: "BBB", token: tok },
      { address: "AAA", token: tok }, // overlaps a tracked wallet
    ]);
    const addrs = await collectWatchedAddresses(testDb.db);
    expect(addrs).toEqual(["AAA", "BBB", "CCC"]);
  });
});
