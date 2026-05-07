import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type IntelEvent,
  _resetIntelBus,
  initIntelBus,
  publish,
  subscribe,
  subscriberCount,
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
  _resetIntelBus();
  await initIntelBus(testDb.sql);
});

afterEach(async () => {
  _resetIntelBus();
});

// Helper: wait until predicate is true or timeout. LISTEN delivery is
// asynchronous (Postgres round-trip), so tests must poll briefly.
async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: predicate never satisfied within timeout");
}

describe("intel-bus", () => {
  test("publish delivers to local subscribers", async () => {
    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    await publish({ event: "check:start", data: { address: "abc" } });
    await publish({
      event: "check:complete",
      data: { address: "abc", score: 42, verdict: "CLEAN" },
    });

    await waitFor(() => seen.length === 2);

    expect(seen[0]!.event).toBe("check:start");
    expect(seen[1]!.event).toBe("check:complete");
    unsub();
  });
});
