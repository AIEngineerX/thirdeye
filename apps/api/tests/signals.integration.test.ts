import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { promoteOrUpdateSignal, recordCoFundedAudit } from "../src/lib/signals";
import { type TestDb, setupTestDb } from "./setup";

let t: TestDb;

beforeEach(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.cleanup();
});

describe("promoteOrUpdateSignal", () => {
  test("creates one open independent signal with the call snapshot", async () => {
    const id = await promoteOrUpdateSignal(t.db, {
      mint: "Mint111",
      symbol: "AAA",
      wallets: ["W1", "W2"],
      firstBuyAtMs: Date.parse("2026-05-28T00:00:00Z"),
      callMc: 75_000,
      callPrice: 0.0001,
    });
    expect(id).not.toBeNull();
    const rows = await t.sql`SELECT * FROM signals WHERE mint = 'Mint111'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.trust).toBe("independent");
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.wallet_count).toBe(2);
    expect(rows[0]!.wallets).toEqual(["W1", "W2"]);
    expect(Number(rows[0]!.call_mc)).toBe(75_000);
  });

  test("a second confluence on the same open mint updates, not duplicates", async () => {
    const base = {
      mint: "Mint222",
      symbol: "BBB",
      firstBuyAtMs: Date.parse("2026-05-28T00:00:00Z"),
      callMc: 50_000,
      callPrice: null,
    };
    await promoteOrUpdateSignal(t.db, { ...base, wallets: ["W1", "W2"] });
    await promoteOrUpdateSignal(t.db, { ...base, wallets: ["W1", "W2", "W3"] });
    const rows = await t.sql`SELECT * FROM signals WHERE mint = 'Mint222'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.wallet_count).toBe(3);
    expect(rows[0]!.wallets).toEqual(["W1", "W2", "W3"]);
  });
});

describe("recordCoFundedAudit", () => {
  test("inserts a closed co_funded row that does not occupy the open-mint slot", async () => {
    await recordCoFundedAudit(t.db, {
      mint: "Mint333",
      symbol: null,
      wallets: ["W1", "W2"],
      firstBuyAtMs: Date.parse("2026-05-28T00:00:00Z"),
      sharedFunder: "F1",
    });
    // An independent signal for the same mint must still be insertable (the
    // partial-unique index only constrains status='open').
    const id = await promoteOrUpdateSignal(t.db, {
      mint: "Mint333",
      symbol: null,
      wallets: ["W4", "W5"],
      firstBuyAtMs: Date.parse("2026-05-28T00:05:00Z"),
      callMc: 10_000,
      callPrice: null,
    });
    expect(id).not.toBeNull();
    const rows = await t.sql`SELECT trust, status FROM signals WHERE mint = 'Mint333' ORDER BY id`;
    expect(rows.map((r) => `${r.trust}/${r.status}`)).toEqual([
      "co_funded/closed",
      "independent/open",
    ]);
  });
});
