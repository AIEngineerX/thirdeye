import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, tokenScans } from "@thirdeye/db";
import { sql } from "drizzle-orm";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
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

async function seedFundersWithScans() {
  // 3 funders with varying cluster_count
  await testDb.db.execute(sql`
    INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen) VALUES
      ('FUNDER_TOP', 50, 5, now() - interval '7 days', now()),
      ('FUNDER_MID', 20, 2, now() - interval '3 days', now()),
      ('FUNDER_LOW', 5, 1, now() - interval '1 day', now()),
      ('FUNDER_ZERO', 100, 0, now() - interval '30 days', now())
  `);
  // 3 token scans, 2 of which have FUNDER_TOP as a cluster root
  await testDb.db.insert(tokenScans).values([
    {
      mint: "MINT_A",
      symbol: "AAA",
      name: "Token A",
      riskPct: "55",
      verdict: "HIGH_RISK",
      sybilFlag: true,
      payload: {
        clusters: [
          { root: "FUNDER_TOP", members: ["w1", "w2", "w3"], totalPct: 12.5 },
          { root: "FUNDER_MID", members: ["w4", "w5"], totalPct: 4 },
        ],
      },
    },
    {
      mint: "MINT_B",
      symbol: "BBB",
      name: "Token B",
      riskPct: "30",
      verdict: "LOW_RISK",
      sybilFlag: false,
      payload: {
        clusters: [{ root: "FUNDER_TOP", members: ["w6", "w7"], totalPct: 6 }],
      },
    },
    {
      mint: "MINT_C",
      symbol: "CCC",
      name: "Token C",
      riskPct: "10",
      verdict: "CLEAN",
      sybilFlag: false,
      payload: { clusters: [] },
    },
  ]);
}

describe("intel/funders/top-clustered", () => {
  test("returns funders sorted by cluster_count DESC, excluding zero", async () => {
    await seedFundersWithScans();
    const r = await app.request("/api/db/intel/funders/top-clustered", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ address: string; clusterCount: number }> };
    expect(body.items.map((i) => i.address)).toEqual(["FUNDER_TOP", "FUNDER_MID", "FUNDER_LOW"]);
    expect(body.items[0]!.clusterCount).toBe(5);
    expect(body.items.find((i) => i.address === "FUNDER_ZERO")).toBeUndefined();
  });

  test("respects limit query param", async () => {
    await seedFundersWithScans();
    const r = await app.request("/api/db/intel/funders/top-clustered?limit=2", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: unknown[]; limit: number };
    expect(body.items.length).toBe(2);
    expect(body.limit).toBe(2);
  });

  test("requires auth", async () => {
    const r = await app.request("/api/db/intel/funders/top-clustered");
    expect(r.status).toBe(401);
  });
});

describe("intel/funders/:addr/clusters", () => {
  test("returns scans where this funder rooted a cluster", async () => {
    await seedFundersWithScans();
    const r = await app.request("/api/db/intel/funders/FUNDER_TOP/clusters", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      funder: string;
      clusters: Array<{ mint: string; memberCount: number; riskPct: number }>;
    };
    expect(body.funder).toBe("FUNDER_TOP");
    expect(body.clusters).toHaveLength(2);
    const mints = body.clusters.map((c) => c.mint).sort();
    expect(mints).toEqual(["MINT_A", "MINT_B"]);
    const a = body.clusters.find((c) => c.mint === "MINT_A");
    expect(a?.memberCount).toBe(3);
    expect(a?.riskPct).toBe(55);
  });

  test("returns empty list for funder with no clusters in payload", async () => {
    await seedFundersWithScans();
    // FUNDER_LOW has cluster_count=1 in funders table but no matching cluster
    // in our seeded payloads — exercises the LATERAL join's no-match branch.
    const r = await app.request("/api/db/intel/funders/FUNDER_LOW/clusters", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { clusters: unknown[] };
    expect(body.clusters).toHaveLength(0);
  });

  test("404 when funder address is not tracked", async () => {
    await seedFundersWithScans();
    const r = await app.request("/api/db/intel/funders/UNKNOWN_FUNDER/clusters", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(404);
  });

  test("requires auth", async () => {
    const r = await app.request("/api/db/intel/funders/FUNDER_TOP/clusters");
    expect(r.status).toBe(401);
  });
});
