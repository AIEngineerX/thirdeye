// Direct DB-integration tests for lib/aggregator.ts. The intel.integration
// test exercises a single happy path; this file covers edges:
//   - empty tables
//   - 24h boundary (rows older than the window are excluded)
//   - DISTINCT mint counting in tokensScanned
//   - null risk_pct in riskDist (must not crash, must not count)
//   - heatmap LIMIT 20 truncation
//   - newClusters only counts funders with cluster_count > 0

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tokenScans, walletChecks, wallets } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { allTime, heatmap, pulse24h, riskDist } from "../src/lib/aggregator";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates RESTART IDENTITY CASCADE;",
  );
});

describe("pulse24h", () => {
  test("empty tables → all zeros", async () => {
    const r = await pulse24h(testDb.db);
    expect(r).toEqual({ scans: 0, checks: 0, newClusters: 0, newBundlers: 0 });
  });

  test("scans/checks older than 24h excluded", async () => {
    await testDb.db.insert(tokenScans).values([
      { mint: "M1", payload: {} },
      { mint: "M2", payload: {} },
    ]);
    // Backdate one of them past the window.
    await testDb.db.execute(
      sql`UPDATE token_scans SET scanned_at = now() - interval '25 hours' WHERE mint = 'M1'`,
    );
    await testDb.db.insert(wallets).values([{ address: "W1", tags: [] }]);
    await testDb.db
      .insert(walletChecks)
      .values([{ address: "W1", score: 0, verdict: "CLEAN", payload: {} }]);
    const r = await pulse24h(testDb.db);
    expect(r.scans).toBe(1); // only M2
    expect(r.checks).toBe(1);
  });

  test("newClusters only counts funders where cluster_count > 0", async () => {
    await testDb.db.execute(sql`
      INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen) VALUES
        ('F1', 10, 0, now(), now()),
        ('F2', 5, 3, now(), now()),
        ('F3', 0, 1, now(), now() - interval '2 days')
    `);
    const r = await pulse24h(testDb.db);
    // F1 excluded (cluster_count=0), F3 excluded (last_seen old), only F2.
    expect(r.newClusters).toBe(1);
  });

  test("newBundlers counts wallets tagged BUNDLER within 24h", async () => {
    await testDb.db.insert(wallets).values([
      { address: "W1", tags: ["BUNDLER"], lastChecked: new Date() },
      { address: "W2", tags: ["FRESH_WALLET"], lastChecked: new Date() },
      { address: "W3", tags: ["BUNDLER", "FRESH_WALLET"], lastChecked: new Date() },
    ]);
    // Stale BUNDLER (older than 24h)
    await testDb.db.insert(wallets).values([{ address: "W4", tags: ["BUNDLER"] }]);
    await testDb.db.execute(
      sql`UPDATE wallets SET last_checked = now() - interval '2 days' WHERE address = 'W4'`,
    );
    const r = await pulse24h(testDb.db);
    expect(r.newBundlers).toBe(2); // W1 + W3, NOT W4 (stale) NOT W2 (no BUNDLER tag)
  });
});

describe("allTime", () => {
  test("empty tables → all zeros", async () => {
    expect(await allTime(testDb.db)).toEqual({
      walletsProfiled: 0,
      tokensScanned: 0,
      clustersDetected: 0,
      bundlersTagged: 0,
    });
  });

  test("DISTINCT mint: re-scanning same mint counts once", async () => {
    await testDb.db.insert(tokenScans).values([
      { mint: "M1", payload: {} },
      { mint: "M1", payload: {} },
      { mint: "M2", payload: {} },
    ]);
    const r = await allTime(testDb.db);
    expect(r.tokensScanned).toBe(2);
  });

  test("clustersDetected sums cluster_count across funders", async () => {
    await testDb.db.execute(sql`
      INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen) VALUES
        ('F1', 0, 5, now(), now()),
        ('F2', 0, 3, now(), now()),
        ('F3', 0, 0, now(), now())
    `);
    const r = await allTime(testDb.db);
    expect(r.clustersDetected).toBe(8);
  });

  test("bundlersTagged counts wallets with BUNDLER tag (any time)", async () => {
    await testDb.db.insert(wallets).values([
      { address: "W1", tags: ["BUNDLER"] },
      { address: "W2", tags: ["BUNDLER", "FRESH_WALLET"] },
      { address: "W3", tags: ["FRESH_WALLET"] },
    ]);
    const r = await allTime(testDb.db);
    expect(r.bundlersTagged).toBe(2);
    expect(r.walletsProfiled).toBe(3);
  });
});

describe("riskDist", () => {
  test("empty → all-zero buckets, total=0", async () => {
    const r = await riskDist(testDb.db);
    expect(r.buckets).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.total).toBe(0);
    expect(r.windowDays).toBe(7);
  });

  test("null risk_pct excluded", async () => {
    // Insert with null risk_pct (column is nullable per schema)
    await testDb.db.execute(
      sql`INSERT INTO token_scans (mint, payload, risk_pct) VALUES ('M_NULL', '{}'::jsonb, NULL)`,
    );
    await testDb.db.insert(tokenScans).values([{ mint: "M1", riskPct: "30", payload: {} }]);
    const r = await riskDist(testDb.db);
    expect(r.total).toBe(1); // only M1
  });

  test("8d-old row excluded", async () => {
    await testDb.db.insert(tokenScans).values([
      { mint: "M_OLD", riskPct: "50", payload: {} },
      { mint: "M_NEW", riskPct: "50", payload: {} },
    ]);
    await testDb.db.execute(
      sql`UPDATE token_scans SET scanned_at = now() - interval '8 days' WHERE mint = 'M_OLD'`,
    );
    const r = await riskDist(testDb.db);
    expect(r.total).toBe(1);
  });

  test("buckets distribute correctly across 0-100 range", async () => {
    // width_bucket(x, 0, 100, 10): edges are [0, 10), [10, 20), ..., [90, 100), [100, +inf)
    await testDb.db.insert(tokenScans).values([
      { mint: "M_5", riskPct: "5", payload: {} }, // bucket 1 → idx 0
      { mint: "M_55", riskPct: "55", payload: {} }, // bucket 6 → idx 5
      { mint: "M_99", riskPct: "99", payload: {} }, // bucket 10 → idx 9
      { mint: "M_100", riskPct: "100", payload: {} }, // bucket 11 clamped → idx 9
    ]);
    const r = await riskDist(testDb.db);
    expect(r.total).toBe(4);
    expect(r.buckets[0]).toBe(1);
    expect(r.buckets[5]).toBe(1);
    expect(r.buckets[9]).toBe(2); // M_99 + M_100
  });
});

describe("heatmap", () => {
  test("empty → empty items array", async () => {
    expect(await heatmap(testDb.db)).toEqual({ items: [] });
  });

  test("LIMIT 20: returns at most 20 most-recent scans", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      mint: `M${i}`,
      symbol: `S${i}`,
      name: null,
      riskPct: String((i * 4) % 100),
      verdict: "CLEAN",
      sybilFlag: false,
      payload: {},
    }));
    await testDb.db.insert(tokenScans).values(rows);
    const r = await heatmap(testDb.db);
    expect(r.items.length).toBe(20);
  });

  test("null risk_pct serialized as 0", async () => {
    await testDb.db.execute(
      sql`INSERT INTO token_scans (mint, symbol, name, payload, risk_pct, verdict)
          VALUES ('MN', 'X', 'X', '{}'::jsonb, NULL, 'CLEAN')`,
    );
    const r = await heatmap(testDb.db);
    expect(r.items[0]!.risk).toBe(0);
  });

  test("scannedAt is ISO string", async () => {
    await testDb.db.insert(tokenScans).values([{ mint: "M1", payload: {} }]);
    const r = await heatmap(testDb.db);
    expect(r.items[0]!.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});
