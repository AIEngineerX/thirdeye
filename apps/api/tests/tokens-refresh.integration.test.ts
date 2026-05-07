import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tokens } from "@thirdeye/db";
import type { PriceQuote, PriceSource } from "@thirdeye/prices";
import { eq } from "drizzle-orm";
import { refreshTokens } from "../src/workers/tokens-refresh";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE tokens RESTART IDENTITY CASCADE;");
});

class StubSource implements PriceSource {
  readonly name = "stub";
  public calls: string[][] = [];
  constructor(private readonly responses: PriceQuote[]) {}
  async fetch(mints: string[]): Promise<PriceQuote[]> {
    this.calls.push(mints);
    return this.responses.filter((r) => mints.includes(r.mint));
  }
}

class FailingSource implements PriceSource {
  readonly name = "failing";
  fetch(): Promise<PriceQuote[]> {
    return Promise.reject(new Error("simulated upstream outage"));
  }
}

async function seed(mint: string, refreshedAgoMin: number): Promise<void> {
  await testDb.sql.unsafe(
    `INSERT INTO tokens (mint, last_refreshed_at)
     VALUES ($1, now() - ($2::int * interval '1 minute'))`,
    [mint, refreshedAgoMin],
  );
}

describe("refreshTokens", () => {
  test("returns zero stats when table is empty", async () => {
    const source = new StubSource([]);
    const stats = await refreshTokens(testDb.db, { source });
    expect(stats).toEqual({ selected: 0, refreshed: 0, errored: 0 });
    expect(source.calls).toHaveLength(0);
  });

  test("selects oldest-refreshed tokens up to batch limit", async () => {
    await seed("OLD", 60);
    await seed("MID", 30);
    await seed("NEW", 5);
    const source = new StubSource([]);
    await refreshTokens(testDb.db, { source, batchLimit: 2 });
    expect(source.calls).toHaveLength(1);
    // Oldest two are picked (OLD + MID).
    expect(source.calls[0]!.sort()).toEqual(["MID", "OLD"]);
  });

  test("upserts price/MC fields on returned quotes", async () => {
    await seed("MINT_A", 60);
    const source = new StubSource([
      {
        mint: "MINT_A",
        symbol: "AAA",
        name: "Token A",
        priceUsd: 0.5,
        mcUsd: 500_000,
        mc24hPct: 25.0,
        liquidityUsd: 10_000,
      },
    ]);
    const stats = await refreshTokens(testDb.db, { source });
    expect(stats.refreshed).toBe(1);

    const rows = await testDb.db.select().from(tokens).where(eq(tokens.mint, "MINT_A"));
    const row = rows[0]!;
    expect(row.symbol).toBe("AAA");
    expect(Number(row.priceUsd)).toBe(0.5);
    expect(Number(row.mcUsd)).toBe(500_000);
    expect(Number(row.mc24hPct)).toBe(25);
    expect(Number(row.liquidityUsd)).toBe(10_000);
  });

  test("missing mints (not returned by source) get last_refreshed_at bumped", async () => {
    await seed("KNOWN", 60);
    await seed("UNKNOWN", 60);
    const source = new StubSource([
      {
        mint: "KNOWN",
        symbol: null,
        name: null,
        priceUsd: 1,
        mcUsd: null,
        mc24hPct: null,
        liquidityUsd: null,
      },
    ]);
    await refreshTokens(testDb.db, { source });

    const rows = await testDb.db.select().from(tokens);
    // Both rows should now have a last_refreshed_at within the last few seconds —
    // the unknown mint's timestamp is bumped so it doesn't reappear at the head
    // of the queue every tick.
    for (const r of rows) {
      const ageSec = (Date.now() - new Date(r.lastRefreshedAt).getTime()) / 1000;
      expect(ageSec).toBeLessThan(10);
    }
  });

  test("source error is non-fatal: stats.errored == selected, no rows updated", async () => {
    await seed("MINT_A", 60);
    const source = new FailingSource();
    const stats = await refreshTokens(testDb.db, { source });
    expect(stats.errored).toBe(1);
    expect(stats.refreshed).toBe(0);

    // last_refreshed_at must be untouched so next tick retries.
    const rows = await testDb.db.select().from(tokens).where(eq(tokens.mint, "MINT_A"));
    const ageSec = (Date.now() - new Date(rows[0]!.lastRefreshedAt).getTime()) / 1000;
    expect(ageSec).toBeGreaterThan(60 - 5); // we seeded "60min ago" — still ~60min
  });

  test("preserves prior symbol when source returns null", async () => {
    await testDb.sql.unsafe(
      `INSERT INTO tokens (mint, symbol, name, last_refreshed_at)
       VALUES ('M', 'OLDSYM', 'Old Name', now() - interval '60 minutes')`,
    );
    const source = new StubSource([
      {
        mint: "M",
        symbol: null, // upstream forgot the symbol this tick
        name: null,
        priceUsd: 2,
        mcUsd: null,
        mc24hPct: null,
        liquidityUsd: null,
      },
    ]);
    await refreshTokens(testDb.db, { source });
    const rows = await testDb.db.select().from(tokens).where(eq(tokens.mint, "M"));
    expect(rows[0]!.symbol).toBe("OLDSYM");
    expect(rows[0]!.name).toBe("Old Name");
    expect(Number(rows[0]!.priceUsd)).toBe(2);
  });
});
