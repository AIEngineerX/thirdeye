import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type IntelEvent,
  _resetIntelBus,
  initIntelBus,
  publish,
  subscribe,
} from "../src/lib/intel-bus";
import { type TestDb, setupTestDb, waitFor } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await _resetIntelBus();
});

afterEach(async () => {
  await _resetIntelBus();
});

describe("intel-bus initIntelBus", () => {
  test("concurrent callers share one LISTEN connection (no double-fire)", async () => {
    // Without the in-flight promise lock, two concurrent initIntelBus calls
    // could each open a LISTEN connection and double-fire every handler.
    // Issue 4 in parallel before any awaits.
    await Promise.all([
      initIntelBus(testDb.sql),
      initIntelBus(testDb.sql),
      initIntelBus(testDb.sql),
      initIntelBus(testDb.sql),
    ]);

    const seen: IntelEvent[] = [];
    subscribe((e) => seen.push(e));

    await publish({
      event: "check:start",
      data: { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" },
    });

    // Allow the LISTEN callback to fire. If two listeners were open, this
    // would deliver the event to the handler twice.
    await waitFor(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(1);
  });

  test("subsequent calls after init no-op", async () => {
    await initIntelBus(testDb.sql);
    await initIntelBus(testDb.sql);
    await initIntelBus(testDb.sql);

    const seen: IntelEvent[] = [];
    subscribe((e) => seen.push(e));

    await publish({
      event: "check:start",
      data: { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" },
    });

    await waitFor(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(1);
  });
});
