// Integration tests for apps/api/src/lib/smart-money.ts
// Real Postgres — no mocks. Run: bun test apps/api/tests/smart-money.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { wallets } from "@thirdeye/db";
import type { ParsedTrade } from "@thirdeye/scanner";
import { areCoFunded, detectBuyConfluence, persistTrade } from "../src/lib/smart-money";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  // Global setup truncates wallets; also truncate smart_trades which setup.ts omits.
  await testDb.sql.unsafe("TRUNCATE smart_trades, wallets RESTART IDENTITY CASCADE;");
});

// Build a minimal ParsedTrade. Each call without overrides gets a unique
// signature derived from a counter so tests don't accidentally conflict.
let tradeSeq = 0;
function buildTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  tradeSeq += 1;
  return {
    wallet: "WALLET_A",
    mint: "MINT_X",
    side: "buy",
    tokenAmount: 1000,
    solAmount: 0.5,
    program: "RAYDIUM",
    signature: `SIG_${tradeSeq}`,
    tradedAt: new Date(),
    ...overrides,
  };
}

describe("persistTrade", () => {
  test("inserts a trade and returns true", async () => {
    const trade = buildTrade();
    const inserted = await persistTrade(testDb.db, trade, "TOKEN");
    expect(inserted).toBe(true);
  });

  test("duplicate (signature, wallet) returns false without inserting a second row", async () => {
    const trade = buildTrade({ signature: "SIG_DUP", wallet: "WALLET_DUP" });
    const first = await persistTrade(testDb.db, trade, "TOKEN");
    const second = await persistTrade(testDb.db, trade, "TOKEN");
    expect(first).toBe(true);
    expect(second).toBe(false);

    // Confirm only one row in DB for this signature+wallet.
    const rows = await testDb.sql.unsafe<{ id: number }[]>(
      "SELECT id FROM smart_trades WHERE signature = 'SIG_DUP' AND wallet = 'WALLET_DUP'",
    );
    expect(rows.length).toBe(1);
  });

  test("same signature, different wallet — both inserted (no conflict)", async () => {
    const sig = "SIG_SHARED";
    const a = await persistTrade(testDb.db, buildTrade({ signature: sig, wallet: "W_AAA" }), null);
    const b = await persistTrade(testDb.db, buildTrade({ signature: sig, wallet: "W_BBB" }), null);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe("detectBuyConfluence", () => {
  test("counts distinct wallets buying the same mint in-window", async () => {
    // Two buys from the same wallet + one from another — should count 2 distinct.
    await persistTrade(testDb.db, buildTrade({ wallet: "W1", mint: "MINT_C" }), null);
    await persistTrade(testDb.db, buildTrade({ wallet: "W1", mint: "MINT_C" }), null); // same wallet, different sig
    await persistTrade(testDb.db, buildTrade({ wallet: "W2", mint: "MINT_C" }), null);

    const conf = await detectBuyConfluence(testDb.db, "MINT_C", 30);
    expect(conf.count).toBe(2);
    expect(conf.wallets.sort()).toEqual(["W1", "W2"]);
    expect(conf.mint).toBe("MINT_C");
    expect(conf.windowMin).toBe(30);
  });

  test("excludes a different mint from the count", async () => {
    await persistTrade(testDb.db, buildTrade({ wallet: "W1", mint: "MINT_TARGET" }), null);
    await persistTrade(testDb.db, buildTrade({ wallet: "W2", mint: "MINT_OTHER" }), null);

    const conf = await detectBuyConfluence(testDb.db, "MINT_TARGET", 30);
    expect(conf.count).toBe(1);
    expect(conf.wallets).toEqual(["W1"]);
  });

  test("excludes trades older than the window", async () => {
    // Insert an in-window trade first.
    await persistTrade(testDb.db, buildTrade({ wallet: "W_RECENT", mint: "MINT_T" }), null);

    // Insert an old trade (2 hours ago) directly via sql to bypass Date() rounding.
    await testDb.sql.unsafe(
      `INSERT INTO smart_trades (wallet, mint, side, sol_amount, token_amount, program, signature, traded_at)
       VALUES ('W_OLD', 'MINT_T', 'buy', 0.5, 1000, 'RAYDIUM', 'SIG_OLD_TRADE', now() - interval '2 hours')`,
    );

    const conf = await detectBuyConfluence(testDb.db, "MINT_T", 30);
    expect(conf.count).toBe(1);
    expect(conf.wallets).toEqual(["W_RECENT"]);
  });

  test("returns zero count when nothing bought in window", async () => {
    const conf = await detectBuyConfluence(testDb.db, "MINT_EMPTY", 30);
    expect(conf.count).toBe(0);
    expect(conf.wallets).toEqual([]);
  });
});

describe("areCoFunded", () => {
  test("returns coFunded:true when >=2 addresses share a first_funder", async () => {
    await testDb.db.insert(wallets).values([
      { address: "WA1", firstFunder: "FUNDER_SHARED", fundedAt: null, tags: [] },
      { address: "WA2", firstFunder: "FUNDER_SHARED", fundedAt: null, tags: [] },
      { address: "WA3", firstFunder: "FUNDER_OTHER", fundedAt: null, tags: [] },
    ]);

    const result = await areCoFunded(testDb.db, ["WA1", "WA2", "WA3"]);
    expect(result.coFunded).toBe(true);
    expect(result.sharedFunder).toBe("FUNDER_SHARED");
  });

  test("returns coFunded:false when all funders differ", async () => {
    await testDb.db.insert(wallets).values([
      { address: "WB1", firstFunder: "F1", fundedAt: null, tags: [] },
      { address: "WB2", firstFunder: "F2", fundedAt: null, tags: [] },
    ]);

    const result = await areCoFunded(testDb.db, ["WB1", "WB2"]);
    expect(result.coFunded).toBe(false);
    expect(result.sharedFunder).toBeNull();
  });

  test("returns coFunded:false when funders are all NULL", async () => {
    await testDb.db.insert(wallets).values([
      { address: "WC1", firstFunder: null, fundedAt: null, tags: [] },
      { address: "WC2", firstFunder: null, fundedAt: null, tags: [] },
    ]);

    const result = await areCoFunded(testDb.db, ["WC1", "WC2"]);
    expect(result.coFunded).toBe(false);
    expect(result.sharedFunder).toBeNull();
  });

  test("returns coFunded:false for a single address (< 2)", async () => {
    const result = await areCoFunded(testDb.db, ["SOLO"]);
    expect(result.coFunded).toBe(false);
    expect(result.sharedFunder).toBeNull();
  });

  test("returns coFunded:false for empty list", async () => {
    const result = await areCoFunded(testDb.db, []);
    expect(result.coFunded).toBe(false);
    expect(result.sharedFunder).toBeNull();
  });
});
