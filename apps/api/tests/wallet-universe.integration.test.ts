import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Leaderboard } from "@thirdeye/solanatracker";
import { listCandidates, syncLeaderboardCandidates } from "../src/lib/wallet-universe";
import { type TestDb, setupTestDb } from "./setup";

let t: TestDb;
beforeEach(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.cleanup();
});

const fakeLeaderboard = (): Leaderboard => ({
  traders: [
    {
      wallet: "Lead1",
      winRate: 80,
      period: { realized: 1000, roi: 50, volume: 1 },
      counts: { tokensTraded: 12 },
      identity: null,
    },
    {
      wallet: "Lead2",
      winRate: 60,
      period: { realized: 500, roi: 20, volume: 1 },
      counts: { tokensTraded: 8 },
      identity: "kol",
    },
  ],
});

describe("syncLeaderboardCandidates", () => {
  test("upserts ST leaderboard rows as candidates with rank", async () => {
    const n = await syncLeaderboardCandidates(t.db, { leaderboard: async () => fakeLeaderboard() });
    expect(n).toBe(2);
    const rows =
      await t.sql`SELECT address, source, src_win_rate, src_rank FROM candidate_wallets ORDER BY src_rank`;
    expect(rows.length).toBe(2);
    expect(rows[0]!.address).toBe("Lead1");
    expect(rows[0]!.source).toBe("st_leaderboard");
    expect(Number(rows[0]!.src_rank)).toBe(1);
    expect(Number(rows[0]!.src_win_rate)).toBe(80);
  });
});

describe("listCandidates", () => {
  test("ranks unpromoted candidates by early_rate then pnl, excludes promoted", async () => {
    await t.sql`INSERT INTO candidate_wallets (address, source, early_rate, src_pnl_all, buys_observed) VALUES
      ('A','fomo_seed',0.8,1000,50),('B','fomo_seed',0.5,5000,40),('C','fomo_seed',NULL,9000,10)`;
    await t.sql`UPDATE candidate_wallets SET promoted=true WHERE address='A'`;
    const rows = await listCandidates(t.db, { limit: 10, includePromoted: false });
    expect(rows.map((r) => r.address)).toEqual(["B", "C"]);
    expect(rows[0]!.earlyRate).toBe(0.5);
  });
});
