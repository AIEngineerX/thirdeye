import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { intelEvents } from "@thirdeye/db";
import { sql as drizzleSql } from "drizzle-orm";
import {
  type IntelEvent,
  _resetIntelBus,
  initIntelBus,
  publish,
  subscribe,
} from "../src/lib/intel-bus";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await _resetIntelBus();
  await initIntelBus(testDb.sql);
});

afterEach(async () => {
  await _resetIntelBus();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: predicate never satisfied");
}

describe("intel-bus overflow path", () => {
  test("payload exceeding NOTIFY limit goes through intel_events table", async () => {
    const seen: IntelEvent[] = [];
    subscribe((e) => seen.push(e));

    // Construct a payload larger than 7800 bytes by stuffing the description.
    const big = "x".repeat(9000);
    const evt: IntelEvent = {
      event: "watch:event",
      data: {
        address: "ADDR",
        signature: "SIG",
        type: "SWAP",
        source: "JUPITER",
        description: big,
        timestamp: 1234567890,
      },
    };

    await publish(evt);
    await waitFor(() => seen.length === 1);

    expect(seen[0]!.event).toBe("watch:event");
    const data = seen[0]!.data as { description: string };
    expect(data.description.length).toBe(9000);

    // Verify the overflow row was deleted by the subscriber.
    const remaining = await testDb.db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(intelEvents);
    expect(remaining[0]!.count).toBe(0);
  });
});
