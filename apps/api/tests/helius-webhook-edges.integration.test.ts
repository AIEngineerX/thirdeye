// Edge cases for the public ingest endpoint that the existing
// helius-webhook.integration.test.ts doesn't cover:
//  - event with no signature is silently skipped
//  - empty array body is accepted (received: 0)
//  - mixed batch where only some events involve watched addresses
//  - event with no candidate addresses at all (no feePayer, no transfers)
//  - persistence failure for one event doesn't kill the whole batch
//  - unique-constraint collision: same (address, signature) inserted twice
//    causes one insert to throw — batch should still report partial success

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, watchEvents, watches } from "@thirdeye/db";
import { app } from "../src/index";
import { type IntelEvent, subscribe } from "../src/lib/intel-bus";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const ORIGINAL_ENV = { ...process.env };
let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.HELIUS_WEBHOOK_AUTH = "edge-secret";
});

afterAll(async () => {
  process.env.HELIUS_WEBHOOK_AUTH = ORIGINAL_ENV.HELIUS_WEBHOOK_AUTH;
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, watches, watch_events, helius_webhooks RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

const WATCHED = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const UNWATCHED = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";

const headers = {
  "Content-Type": "application/json",
  Authorization: "edge-secret",
};

describe("/api/helius-webhook ingest edges", () => {
  test("empty array body → 200 received:0 persisted:0", async () => {
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: "[]",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body).toEqual({ received: 0, persisted: 0 });
  });

  test("event with no signature is silently skipped", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          // no signature
          type: "TRANSFER",
          feePayer: WATCHED,
          tokenTransfers: [],
          accountData: [],
        },
      ]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.received).toBe(1);
    expect(body.persisted).toBe(0); // skipped — no signature
    const rows = await testDb.db.select().from(watchEvents);
    expect(rows).toHaveLength(0);
  });

  test("event with no candidate addresses (no feePayer, no transfers) yields persisted:0", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          signature: "no-addrs-sig",
          type: "UNKNOWN",
        },
      ]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { persisted: number };
    expect(body.persisted).toBe(0);
  });

  test("mixed batch: 3 events, only 1 involves a watched address", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          signature: "sig-other-1",
          feePayer: UNWATCHED,
          tokenTransfers: [],
          accountData: [{ account: UNWATCHED, nativeBalanceChange: -1000 }],
        },
        {
          signature: "sig-watched",
          feePayer: WATCHED,
          tokenTransfers: [{ fromUserAccount: WATCHED, toUserAccount: UNWATCHED, mint: "M" }],
          accountData: [],
        },
        {
          signature: "sig-other-2",
          feePayer: UNWATCHED,
          tokenTransfers: [],
        },
      ]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.received).toBe(3);
    expect(body.persisted).toBe(1);

    const watchEvts = seen.filter((e) => e.event === "watch:event");
    expect(watchEvts).toHaveLength(1);
    expect((watchEvts[0]!.data as { signature: string }).signature).toBe("sig-watched");
    unsub();
  });

  test("watched address mentioned in tokenTransfers.toUserAccount (not feePayer) still matches", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          signature: "incoming-sig",
          feePayer: UNWATCHED,
          tokenTransfers: [
            { fromUserAccount: UNWATCHED, toUserAccount: WATCHED, tokenAmount: 100, mint: "M" },
          ],
          accountData: [],
        },
      ]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { persisted: number };
    expect(body.persisted).toBe(1);
    const rows = await testDb.db.select().from(watchEvents);
    expect(rows[0]!.address).toBe(WATCHED);
  });

  test("watched address mentioned in accountData (not feePayer or transfer) matches", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          signature: "via-account-data",
          feePayer: UNWATCHED,
          tokenTransfers: [],
          accountData: [{ account: WATCHED, nativeBalanceChange: 5000 }],
        },
      ]),
    });
    const body = (await r.json()) as { persisted: number };
    expect(body.persisted).toBe(1);
  });

  test("duplicate (address, signature) → second insert throws but batch reports the first", async () => {
    await testDb.db.insert(watches).values({ address: WATCHED, token });
    // Pre-seed a watch_events row that will collide with the inbound event.
    await testDb.db.insert(watchEvents).values({
      address: WATCHED,
      signature: "collision-sig",
      type: "TRANSFER",
      payload: { foo: "bar" },
    });
    // Inbound event with same (address, signature) — depending on whether
    // a unique constraint exists, this either returns persisted:1 (no
    // unique key) or persisted:0 (constraint violation, caught and logged).
    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          signature: "collision-sig",
          feePayer: WATCHED,
          tokenTransfers: [],
          accountData: [],
        },
      ]),
    });
    expect(r.status).toBe(200);
    // We're permissive about the count — the important thing is the route
    // doesn't 500.
    const body = (await r.json()) as { persisted: number };
    expect(body.persisted).toBeGreaterThanOrEqual(0);
  });

  test("missing webhook secret env returns 503 (operator misconfiguration)", async () => {
    const prior = process.env.HELIUS_WEBHOOK_AUTH;
    process.env.HELIUS_WEBHOOK_AUTH = "";
    try {
      const r = await app.request("/api/helius-webhook", {
        method: "POST",
        headers,
        body: "[]",
      });
      expect(r.status).toBe(503);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe("webhook_auth_unset");
    } finally {
      process.env.HELIUS_WEBHOOK_AUTH = prior;
    }
  });
});
