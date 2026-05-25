import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type IntelEvent, _resetIntelBus, initIntelBus, publish, subscribe } from "../src/lib/intel-bus";
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
  await initIntelBus(testDb.sql);
});

afterEach(async () => {
  await _resetIntelBus();
});

describe("intel-bus smartmoney events", () => {
  test("smartmoney:trade round-trips through the bus", async () => {
    const received: IntelEvent[] = [];
    const unsub = subscribe((e) => received.push(e));
    await publish({
      event: "smartmoney:trade",
      data: {
        wallet: "AAA",
        label: "alpha",
        winRate: 0.71,
        side: "buy",
        mint: "MINT",
        symbol: "TKN",
        solAmount: 1.5,
        signature: "sig1",
        tradedAt: "2026-05-25T00:00:00.000Z",
      },
    });
    await waitFor(() => received.some((e) => e.event === "smartmoney:trade"));
    expect(received.some((e) => e.event === "smartmoney:trade")).toBe(true);
    unsub();
  });

  test("smartmoney:confluence round-trips through the bus", async () => {
    const received: IntelEvent[] = [];
    const unsub = subscribe((e) => received.push(e));
    await publish({
      event: "smartmoney:confluence",
      data: {
        mint: "MINT2",
        symbol: "ABC",
        wallets: ["W1", "W2", "W3"],
        count: 3,
        windowMin: 15,
        coFunded: true,
        sharedFunder: "FUNDER1",
      },
    });
    await waitFor(() => received.some((e) => e.event === "smartmoney:confluence"));
    expect(received.some((e) => e.event === "smartmoney:confluence")).toBe(true);
    unsub();
  });
});
