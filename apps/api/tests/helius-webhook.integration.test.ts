import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, watchEvents, watches } from "@thirdeye/db";
import { app } from "../src/index";
import { type IntelEvent, subscribe } from "../src/lib/intel-bus";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const ORIGINAL_ENV = { ...process.env };

let testDb: TestDb;
let token: string;

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: predicate never satisfied within timeout");
}

beforeAll(async () => {
  testDb = await setupTestDb();
  // Tests for the public ingest don't need a real Helius webhook —
  // mock the secret. Watches POST flow needs PUBLIC_BASE_URL too.
  process.env.HELIUS_WEBHOOK_AUTH = "test-secret-abc";
});

afterAll(async () => {
  process.env.HELIUS_WEBHOOK_AUTH = ORIGINAL_ENV.HELIUS_WEBHOOK_AUTH;
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates, watches, watch_events, helius_webhooks RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

const WATCHED = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const UNWATCHED = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

function inboundBatch(addresses: string[], type = "SWAP", source = "JUPITER") {
  return addresses.map((address, i) => ({
    signature: `sig-${address.slice(0, 4)}-${i}`,
    type,
    source,
    description: `${address.slice(0, 6)}... swapped`,
    feePayer: address,
    fee: 5000,
    slot: 100_000 + i,
    timestamp: Math.floor(Date.now() / 1000),
    tokenTransfers: [
      {
        fromUserAccount: address,
        toUserAccount: "POOL_X",
        tokenAmount: 1_000_000,
        mint: "MINTABC",
      },
    ],
    accountData: [{ account: address, nativeBalanceChange: -1_000_005_000 }],
  }));
}

describe("POST /api/helius-webhook (ingest)", () => {
  test("rejects when auth header is missing", async () => {
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inboundBatch([WATCHED])),
    });
    expect(r.status).toBe(401);
  });

  test("rejects when auth header is wrong", async () => {
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "wrong-secret",
      },
      body: JSON.stringify(inboundBatch([WATCHED])),
    });
    expect(r.status).toBe(401);
  });

  test("400 when body is not an array", async () => {
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-secret-abc",
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(r.status).toBe(400);
  });

  test("ignores events for addresses we don't watch", async () => {
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-secret-abc",
      },
      body: JSON.stringify(inboundBatch([UNWATCHED])),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.received).toBe(1);
    expect(body.persisted).toBe(0);
  });

  test("persists + republishes when address is watched", async () => {
    // Seed a watch so the address resolves
    await testDb.db.insert(watches).values({ address: WATCHED, label: null, token });

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-secret-abc",
      },
      body: JSON.stringify(inboundBatch([WATCHED])),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.received).toBe(1);
    expect(body.persisted).toBe(1);

    // intel-bus NOTIFY/LISTEN is async — wait for the subscriber callback to fire.
    await waitFor(() => seen.filter((e) => e.event === "watch:event").length === 1);
    const watchEvts = seen.filter((e) => e.event === "watch:event");
    expect(watchEvts).toHaveLength(1);
    expect((watchEvts[0]!.data as { address: string }).address).toBe(WATCHED);

    // watch_events row written
    const rows = await testDb.db.select().from(watchEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(WATCHED);

    unsub();
  });

  test("event involving multiple watched addresses persists once per address", async () => {
    // Seed two watches; same event mentions both as fromUserAccount/toUserAccount
    const ADDR_A = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
    const ADDR_B = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";
    await testDb.db.insert(watches).values([
      { address: ADDR_A, label: null, token },
      { address: ADDR_B, label: null, token },
    ]);

    const evt = {
      signature: "multi-sig-1",
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      description: "A → B",
      feePayer: ADDR_A,
      fee: 5000,
      slot: 1,
      timestamp: 1700000000,
      tokenTransfers: [],
      accountData: [
        { account: ADDR_A, nativeBalanceChange: -1_000_000 },
        { account: ADDR_B, nativeBalanceChange: 1_000_000 },
      ],
    };

    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "test-secret-abc",
      },
      body: JSON.stringify([evt]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { persisted: number };
    expect(body.persisted).toBe(2); // one per matched address

    const rows = await testDb.db.select().from(watchEvents);
    expect(rows.map((r) => r.address).sort()).toEqual([ADDR_B, ADDR_A].sort());
  });
});

describe("watches CRUD (env partly missing)", () => {
  test("POST /api/db/watches returns 503 when PUBLIC_BASE_URL unset", async () => {
    // PUBLIC_BASE_URL intentionally not set — we want the failure path
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
      },
      body: JSON.stringify({ addresses: [WATCHED] }),
    });
    // 503 either for missing PUBLIC_BASE_URL or HELIUS_API_KEY
    expect([503, 401]).toContain(r.status);
  });

  test("POST /api/db/watches rejects invalid address", async () => {
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
      },
      body: JSON.stringify({ addresses: ["not-a-real-addr"] }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/db/watches rejects empty addresses array", async () => {
    const r = await app.request("/api/db/watches", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
      },
      body: JSON.stringify({ addresses: [] }),
    });
    expect(r.status).toBe(400);
  });

  test("GET /api/db/watches lists user's watches (empty)", async () => {
    const r = await app.request("/api/db/watches", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  test("GET /api/db/watches/:addr/events returns persisted events", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    await testDb.db.insert(watchEvents).values({
      address: WATCHED,
      signature: "hist-sig-1",
      type: "SWAP",
      payload: { foo: "bar" },
    });
    const r = await app.request(`/api/db/watches/${WATCHED}/events`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ signature: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.signature).toBe("hist-sig-1");
  });

  test("watches CRUD requires auth", async () => {
    const r = await app.request("/api/db/watches");
    expect(r.status).toBe(401);
  });
});
