// Direct DB-integration tests for token/persist.ts. Pins down persistScan,
// lookupRecentScan, resolvePriorTags. Funder cluster_count increments are
// the only side-effect used by Phase 5c (top-clustered funders) — verify
// they're correct.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { funders, tokenScans, tokens, wallets } from "@thirdeye/db";
import type { TokenScanResult } from "@thirdeye/scanner";
import { eq, sql } from "drizzle-orm";
import { lookupRecentScan, persistScan, resolvePriorTags } from "../src/routes/token/persist";
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
    "TRUNCATE auth_tokens, wallet_checks, wallets, token_scans, funders, intel_aggregates, tokens RESTART IDENTITY CASCADE;",
  );
});

function buildScan(overrides: Partial<TokenScanResult> = {}): TokenScanResult {
  return {
    mint: "MINT_X",
    mode: "shared" as unknown as TokenScanResult["mode"],
    metadata: {
      mint: "MINT_X",
      name: "TokenX",
      symbol: "TKX",
      supply: "1000000000000",
      decimals: 9,
      updateAuthority: null,
      firstCreator: null,
    },
    totalHolders: 100,
    scannedHolders: 100,
    topHolders: [],
    lp: { totalPct: 5, holders: [] },
    locked: { totalPct: 10, holders: [] },
    clusters: [
      {
        root: "FUNDER_A",
        members: ["m1", "m2", "m3"],
        totalPct: 12,
        isFreshFunder: false,
        priorTags: {},
      },
      {
        root: "FUNDER_B",
        members: ["m4"],
        totalPct: 3,
        isFreshFunder: true,
        priorTags: {},
      },
    ],
    totalClusteredPct: 15,
    maxClusterPct: 12,
    freshFunderCount: 1,
    risk: 42,
    sybilFlag: true,
    verdict: "HIGH_RISK" as unknown as TokenScanResult["verdict"],
    scannedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("persistScan (real DB)", () => {
  test("inserts token_scans row with derived columns", async () => {
    await persistScan(testDb.db, buildScan());
    const rows = await testDb.db.select().from(tokenScans);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.mint).toBe("MINT_X");
    expect(row.symbol).toBe("TKX");
    expect(row.totalHolders).toBe(100);
    expect(row.clusterCount).toBe(2);
    expect(Number(row.clusteredPct)).toBeCloseTo(15);
    expect(Number(row.lpPct)).toBeCloseTo(5);
    expect(Number(row.lockedPct)).toBeCloseTo(10);
    expect(Number(row.riskPct)).toBeCloseTo(42);
    expect(row.sybilFlag).toBe(true);
    expect(row.verdict).toBe("HIGH_RISK");
  });

  test("increments cluster_count once per detected cluster root", async () => {
    await persistScan(testDb.db, buildScan());
    const f = await testDb.db.select().from(funders);
    expect(f.map((r) => r.address).sort()).toEqual(["FUNDER_A", "FUNDER_B"]);
    expect(f.find((r) => r.address === "FUNDER_A")!.clusterCount).toBe(1);
    expect(f.find((r) => r.address === "FUNDER_B")!.clusterCount).toBe(1);
    // fanout_count comes from check-wallet's persist, not scan-token.
    expect(f.find((r) => r.address === "FUNDER_A")!.fanoutCount).toBe(0);
  });

  test("a funder appearing as cluster root in two scans gets cluster_count=2", async () => {
    await persistScan(testDb.db, buildScan({ mint: "MINT_1" }));
    await persistScan(testDb.db, buildScan({ mint: "MINT_2" }));
    const r = await testDb.db.select().from(funders).where(eq(funders.address, "FUNDER_A"));
    expect(r[0]!.clusterCount).toBe(2);
  });

  test("scan with no clusters writes no funder rows", async () => {
    await persistScan(testDb.db, buildScan({ clusters: [] }));
    const f = await testDb.db.select().from(funders);
    expect(f).toHaveLength(0);
  });

  test("payload column round-trips full scan result", async () => {
    const scan = buildScan();
    await persistScan(testDb.db, scan);
    const rows = await testDb.db.select().from(tokenScans);
    expect(rows[0]!.payload).toBeTruthy();
    const payload = rows[0]!.payload as TokenScanResult;
    expect(payload.mint).toBe(scan.mint);
    expect(payload.clusters).toHaveLength(2);
    expect(payload.clusters[0]!.root).toBe("FUNDER_A");
  });

  test("seeds tokens cache row on first scan (Phase 6a auto-track)", async () => {
    await persistScan(testDb.db, buildScan());
    const rows = await testDb.db.select().from(tokens).where(eq(tokens.mint, "MINT_X"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe("TKX");
    expect(rows[0]!.name).toBe("TokenX");
    // Price columns are null until the worker refreshes from DexScreener.
    expect(rows[0]!.priceUsd).toBeNull();
  });

  test("scanning the same mint twice does not duplicate the tokens row", async () => {
    await persistScan(testDb.db, buildScan());
    await persistScan(testDb.db, buildScan({ risk: 90 }));
    const rows = await testDb.db.select().from(tokens).where(eq(tokens.mint, "MINT_X"));
    expect(rows).toHaveLength(1);
  });
});

describe("lookupRecentScan", () => {
  test("returns null when nothing in window", async () => {
    expect(await lookupRecentScan(testDb.db, "NEVER", 60)).toBeNull();
  });

  test("returns most recent scan within window", async () => {
    await persistScan(testDb.db, buildScan({ risk: 10 }));
    await persistScan(testDb.db, buildScan({ risk: 90 }));
    const r = await lookupRecentScan(testDb.db, "MINT_X", 60);
    expect(r).not.toBeNull();
    expect(r!.risk).toBe(90);
  });

  test("returns null when row is outside window", async () => {
    await persistScan(testDb.db, buildScan());
    await testDb.db.execute(sql`UPDATE token_scans SET scanned_at = now() - interval '1 day'`);
    expect(await lookupRecentScan(testDb.db, "MINT_X", 60)).toBeNull();
  });

  test("isolates by mint", async () => {
    await persistScan(testDb.db, buildScan({ mint: "MINT_A" }));
    expect(await lookupRecentScan(testDb.db, "MINT_B", 60)).toBeNull();
  });
});

describe("resolvePriorTags", () => {
  test("empty input returns empty map (no DB hit)", async () => {
    const r = await resolvePriorTags(testDb.db, []);
    expect(r.size).toBe(0);
  });

  test("returns map of address → tags for present wallets only", async () => {
    await testDb.db.insert(wallets).values([
      { address: "W1", tags: ["BUNDLER"] },
      { address: "W2", tags: ["FRESH_WALLET", "BUNDLER"] },
      { address: "W3", tags: [] },
    ]);
    const r = await resolvePriorTags(testDb.db, ["W1", "W2", "W3", "MISSING"]);
    expect(r.get("W1")).toEqual(["BUNDLER"]);
    expect(r.get("W2")).toEqual(["FRESH_WALLET", "BUNDLER"]);
    expect(r.get("W3")).toEqual([]);
    expect(r.has("MISSING")).toBe(false);
  });

  test("default tags ('{}') yields empty array via DB default", async () => {
    // Schema declares `tags` NOT NULL DEFAULT '{}' — inserting without a tags
    // column exercises the default path. Verifies resolvePriorTags returns
    // the expected empty array (and proves the `?? []` fallback in the
    // implementation never fires in practice).
    await testDb.db.execute(sql`INSERT INTO wallets (address) VALUES ('W_DEFAULT')`);
    const r = await resolvePriorTags(testDb.db, ["W_DEFAULT"]);
    expect(r.get("W_DEFAULT")).toEqual([]);
  });
});
