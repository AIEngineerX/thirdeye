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
  await _resetIntelBus();
  await initIntelBus(testDb.sql);
});

afterEach(async () => {
  await _resetIntelBus();
});

// Helper: wait until predicate is true or timeout. LISTEN delivery is
// asynchronous (Postgres round-trip), so tests must poll briefly.
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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

  test("unsubscribe stops delivery", async () => {
    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    await publish({ event: "scan:start", data: { mint: "M", symbol: null } });
    await waitFor(() => seen.length === 1);

    unsub();
    await publish({ event: "scan:start", data: { mint: "N", symbol: null } });
    // Give any in-flight delivery a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);
  });

  test("multiple subscribers all receive", async () => {
    const a: IntelEvent[] = [];
    const b: IntelEvent[] = [];
    const unsubA = subscribe((e) => a.push(e));
    const unsubB = subscribe((e) => b.push(e));

    await publish({ event: "check:start", data: { address: "x" } });
    await waitFor(() => a.length === 1 && b.length === 1);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    unsubB();
  });

  test("handler that throws does not break sibling delivery", async () => {
    const seen: IntelEvent[] = [];
    const unsubBad = subscribe(() => {
      throw new Error("bad handler");
    });
    const unsubGood = subscribe((e) => seen.push(e));

    await publish({ event: "check:start", data: { address: "x" } });
    await waitFor(() => seen.length === 1);

    expect(seen).toHaveLength(1);
    unsubBad();
    unsubGood();
  });

  test("subscriberCount tracks add/remove", () => {
    const before = subscriberCount();
    const u1 = subscribe(() => {});
    const u2 = subscribe(() => {});
    expect(subscriberCount()).toBe(before + 2);
    u1();
    expect(subscriberCount()).toBe(before + 1);
    u2();
    expect(subscriberCount()).toBe(before);
  });
});
