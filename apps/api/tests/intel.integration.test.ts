import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, tokenScans, walletChecks, wallets } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { refreshAggregates } from "../src/workers/refresh-aggregates";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;
let token: string;

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
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

async function seedFixtures() {
  // 3 wallets: 2 tagged BUNDLER, 1 untagged
  await testDb.db.insert(wallets).values([
    { address: "WAL1", tags: ["BUNDLER"], lastChecked: new Date() },
    { address: "WAL2", tags: ["BUNDLER", "FRESH_WALLET"], lastChecked: new Date() },
    { address: "WAL3", tags: [], lastChecked: new Date() },
  ]);
  // 4 token scans, varied risk
  await testDb.db.insert(tokenScans).values([
    {
      mint: "MINT1",
      symbol: "AAA",
      name: null,
      riskPct: "5",
      verdict: "CLEAN",
      sybilFlag: false,
      payload: { mint: "MINT1" },
    },
    {
      mint: "MINT2",
      symbol: "BBB",
      name: null,
      riskPct: "25",
      verdict: "LOW_RISK",
      sybilFlag: false,
      payload: { mint: "MINT2" },
    },
    {
      mint: "MINT3",
      symbol: "CCC",
      name: null,
      riskPct: "55",
      verdict: "HIGH_RISK",
      sybilFlag: true,
      payload: { mint: "MINT3" },
    },
    {
      mint: "MINT4",
      symbol: "DDD",
      name: null,
      riskPct: "95",
      verdict: "HIGH_RISK",
      sybilFlag: true,
      payload: { mint: "MINT4" },
    },
  ]);
  // 2 wallet checks
  await testDb.db.insert(walletChecks).values([
    { address: "WAL1", score: 30, verdict: "BUNDLER", payload: {} },
    { address: "WAL2", score: 15, verdict: "FRESH", payload: {} },
  ]);
  // 1 funder with cluster_count > 0
  await testDb.db.execute(sql`
    INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen)
    VALUES ('FUNDER1', 5, 2, now(), now())
  `);
}

describe("aggregator (real DB)", () => {
  test("refreshAggregates writes all 4 keys with correct shape", async () => {
    await seedFixtures();
    await refreshAggregates(testDb.db);

    const r = await app.request("/api/db/intel/aggregates", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, Record<string, unknown>>;

    expect(body.pulse24h).toBeDefined();
    expect(body.pulse24h?.scans).toBe(4);
    expect(body.pulse24h?.checks).toBe(2);
    expect(body.pulse24h?.newClusters).toBe(1);
    expect(body.pulse24h?.newBundlers).toBe(2);

    expect(body.allTime).toBeDefined();
    expect(body.allTime?.walletsProfiled).toBe(3);
    expect(body.allTime?.tokensScanned).toBe(4);
    expect(body.allTime?.clustersDetected).toBe(2);
    expect(body.allTime?.bundlersTagged).toBe(2);

    expect(body.riskDist).toBeDefined();
    expect(Array.isArray(body.riskDist?.buckets)).toBe(true);
    expect((body.riskDist?.buckets as number[]).length).toBe(10);
    expect(body.riskDist?.total).toBe(4);

    expect(body.heatmap).toBeDefined();
    expect(Array.isArray(body.heatmap?.items)).toBe(true);
    expect((body.heatmap?.items as unknown[]).length).toBe(4);
  });

  test("aggregates endpoint returns empty object when never refreshed", async () => {
    const r = await app.request("/api/db/intel/aggregates", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(0);
  });
});

describe("intel recent routes", () => {
  test("recent scans paginates", async () => {
    await seedFixtures();
    const r = await app.request("/api/db/intel/recent/scans?limit=2", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; limit: number };
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
  });

  test("recent checks paginates", async () => {
    await seedFixtures();
    const r = await app.request("/api/db/intel/recent/checks", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  test("aggregates require auth", async () => {
    const r = await app.request("/api/db/intel/aggregates");
    expect(r.status).toBe(401);
  });
});

describe("intel feed (SSE)", () => {
  test("missing token query param returns 401", async () => {
    const r = await app.request("/api/db/intel/feed");
    expect(r.status).toBe(401);
  });

  test("invalid token returns 401", async () => {
    const r = await app.request("/api/db/intel/feed?token=bogus");
    expect(r.status).toBe(401);
  });
});
