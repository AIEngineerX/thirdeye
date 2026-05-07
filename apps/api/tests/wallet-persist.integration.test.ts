// Direct DB-integration tests for wallet/persist.ts. The route handler is
// covered elsewhere; this file pins down persistCheck/lookupRecentCheck/
// resolveSiblings semantics — upsert COALESCE behavior, funders fanout
// increment, cache cutoff, sibling resolution.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { funders, walletChecks, wallets } from "@thirdeye/db";
import type { WalletCheckResult } from "@thirdeye/scanner";
import { eq, sql } from "drizzle-orm";
import { lookupRecentCheck, persistCheck, resolveSiblings } from "../src/routes/wallet/persist";
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

function buildResult(overrides: Partial<WalletCheckResult> = {}): WalletCheckResult {
  return {
    address: "WAL_X",
    mode: "shared",
    identity: {
      address: "WAL_X",
      domains: [],
      isProgram: false,
      knownLabel: null,
    } as unknown as WalletCheckResult["identity"],
    balances: {
      solBalance: 1.5,
      usdValue: 250,
      tokens: [],
    } as unknown as WalletCheckResult["balances"],
    funding: {
      chain: [
        {
          funder: "FUNDER_X",
          fundedAt: "2025-01-01T00:00:00Z",
        } as unknown as WalletCheckResult["funding"]["chain"][number],
      ],
    },
    cluster: {
      firstFunder: "FUNDER_X",
      size: 0,
      siblings: [],
      timeWindowSiblings: [],
      cov: null,
    },
    txPattern: {
      txCount: 10,
      ageDays: 30,
      avgGapSec: 600,
      swapOnly: false,
      rapidFire: false,
      uniqueOutboundRecipients: 5,
    },
    tags: ["BUNDLER"] as unknown as WalletCheckResult["tags"],
    realizedPnlSol: 2.25,
    score: 35,
    scoreBucket: "warn" as unknown as WalletCheckResult["scoreBucket"],
    verdict: "BUNDLER" as unknown as WalletCheckResult["verdict"],
    scannedAt: "2025-01-01T01:00:00Z",
    ...overrides,
  };
}

describe("persistCheck (real DB)", () => {
  test("inserts wallet, walletCheck, and funder row on first call", async () => {
    const r = buildResult();
    await persistCheck(testDb.db, r);

    const w = await testDb.db.select().from(wallets);
    expect(w).toHaveLength(1);
    expect(w[0]!.address).toBe("WAL_X");
    expect(w[0]!.firstFunder).toBe("FUNDER_X");
    expect(w[0]!.fundedAt).toBeInstanceOf(Date);
    // numeric stored as string by drizzle on read
    expect(Number(w[0]!.solBalance)).toBeCloseTo(1.5);
    expect(Number(w[0]!.realizedPnlSol)).toBeCloseTo(2.25);
    expect(w[0]!.tags).toEqual(["BUNDLER"]);

    const wc = await testDb.db.select().from(walletChecks);
    expect(wc).toHaveLength(1);
    expect(wc[0]!.address).toBe("WAL_X");
    expect(wc[0]!.score).toBe(35);
    expect(wc[0]!.verdict).toBe("BUNDLER");

    const f = await testDb.db.select().from(funders);
    expect(f).toHaveLength(1);
    expect(f[0]!.address).toBe("FUNDER_X");
    expect(f[0]!.fanoutCount).toBe(1);
    expect(f[0]!.clusterCount).toBe(0);
  });

  test("upsert COALESCEs firstFunder/fundedAt — never overwrites once set", async () => {
    await persistCheck(testDb.db, buildResult({ address: "WAL_Y" }));
    // Second persist with NEW funder + updated balances — original firstFunder must persist.
    await persistCheck(
      testDb.db,
      buildResult({
        address: "WAL_Y",
        funding: {
          chain: [
            {
              funder: "DIFFERENT_FUNDER",
              fundedAt: "2025-02-01T00:00:00Z",
            } as unknown as WalletCheckResult["funding"]["chain"][number],
          ],
        },
        balances: {
          solBalance: 99,
          usdValue: 9999,
          tokens: [],
        } as unknown as WalletCheckResult["balances"],
      }),
    );

    const rows = await testDb.db.select().from(wallets).where(eq(wallets.address, "WAL_Y"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstFunder).toBe("FUNDER_X"); // preserved
    expect(Number(rows[0]!.solBalance)).toBeCloseTo(99); // updated
  });

  test("funder fanout increments on second persist with same firstFunder", async () => {
    await persistCheck(testDb.db, buildResult({ address: "W1" }));
    await persistCheck(testDb.db, buildResult({ address: "W2" }));
    await persistCheck(testDb.db, buildResult({ address: "W3" }));

    const f = await testDb.db.select().from(funders).where(eq(funders.address, "FUNDER_X"));
    expect(f[0]!.fanoutCount).toBe(3);
  });

  test("two wallet_checks rows for same address (history is preserved)", async () => {
    await persistCheck(testDb.db, buildResult({ score: 10 }));
    await persistCheck(testDb.db, buildResult({ score: 50 }));
    const rows = await testDb.db.select().from(walletChecks);
    expect(rows).toHaveLength(2);
    const scores = rows.map((r) => r.score).sort();
    expect(scores).toEqual([10, 50]);
  });

  test("null firstFunder: no funder row written", async () => {
    await persistCheck(
      testDb.db,
      buildResult({
        funding: { chain: [] },
        cluster: {
          firstFunder: null,
          size: 0,
          siblings: [],
          timeWindowSiblings: [],
          cov: null,
        },
      }),
    );
    const f = await testDb.db.select().from(funders);
    expect(f).toHaveLength(0);

    const w = await testDb.db.select().from(wallets);
    expect(w[0]!.firstFunder).toBeNull();
    expect(w[0]!.fundedAt).toBeNull();
  });

  test("null realizedPnlSol stored as NULL not 'null'", async () => {
    await persistCheck(testDb.db, buildResult({ realizedPnlSol: null }));
    const w = await testDb.db.select().from(wallets);
    expect(w[0]!.realizedPnlSol).toBeNull();
  });
});

describe("lookupRecentCheck", () => {
  test("returns null when nothing in window", async () => {
    const r = await lookupRecentCheck(testDb.db, "NEVER_CHECKED", 60);
    expect(r).toBeNull();
  });

  test("returns most recent check within window", async () => {
    await persistCheck(testDb.db, buildResult({ score: 1 }));
    await persistCheck(testDb.db, buildResult({ score: 2 }));
    const r = await lookupRecentCheck(testDb.db, "WAL_X", 60);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(2); // newest
  });

  test("returns null when newest row is older than cutoff", async () => {
    await persistCheck(testDb.db, buildResult());
    // Push checkedAt back to 2 hours ago.
    await testDb.db.execute(sql`UPDATE wallet_checks SET checked_at = now() - interval '2 hours'`);
    const r = await lookupRecentCheck(testDb.db, "WAL_X", 60);
    expect(r).toBeNull();
  });
});

describe("resolveSiblings", () => {
  test("returns wallets matching firstFunder, capped at limit", async () => {
    // Seed three wallets all with same firstFunder, plus one different.
    await testDb.db.insert(wallets).values([
      { address: "S1", firstFunder: "F", fundedAt: new Date("2025-01-01T00:00:00Z"), tags: [] },
      { address: "S2", firstFunder: "F", fundedAt: new Date("2025-01-02T00:00:00Z"), tags: [] },
      { address: "S3", firstFunder: "F", fundedAt: null, tags: [] },
      { address: "OTHER", firstFunder: "G", fundedAt: null, tags: [] },
    ]);
    const sibs = await resolveSiblings(testDb.db, "F", 5);
    expect(sibs.map((s) => s.address).sort()).toEqual(["S1", "S2", "S3"]);

    const limited = await resolveSiblings(testDb.db, "F", 2);
    expect(limited.length).toBe(2);
  });

  test("returns ISO string for fundedAt or null preserved", async () => {
    await testDb.db.insert(wallets).values([
      { address: "S1", firstFunder: "F", fundedAt: new Date("2025-01-01T00:00:00Z"), tags: [] },
      { address: "S2", firstFunder: "F", fundedAt: null, tags: [] },
    ]);
    const sibs = await resolveSiblings(testDb.db, "F", 5);
    const s1 = sibs.find((s) => s.address === "S1")!;
    const s2 = sibs.find((s) => s.address === "S2")!;
    expect(s1.fundedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(s2.fundedAt).toBeNull();
  });

  test("returns empty array when funder not present", async () => {
    const sibs = await resolveSiblings(testDb.db, "NOPE", 50);
    expect(sibs).toEqual([]);
  });
});
