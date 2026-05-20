import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authIssueRateBuckets, sseTickets } from "@thirdeye/db";
import { cleanupTables } from "../src/workers/cleanup-tables";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE sse_tickets, auth_issue_rate_buckets RESTART IDENTITY;");
});

describe("cleanupTables worker", () => {
  test("deletes expired sse_tickets, leaves unexpired", async () => {
    await testDb.db.insert(sseTickets).values([
      { ticket: "expired-1", token: "tok1", expiresAt: new Date(Date.now() - 1000) },
      { ticket: "expired-2", token: "tok2", expiresAt: new Date(Date.now() - 60_000) },
      { ticket: "fresh-1", token: "tok3", expiresAt: new Date(Date.now() + 30_000) },
    ]);
    const stats = await cleanupTables(testDb.db);
    expect(stats.ssesTicketsDeleted).toBe(2);
    const remaining = await testDb.db.select().from(sseTickets);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.ticket).toBe("fresh-1");
  });

  test("deletes stale auth_issue_rate_buckets older than 2h, leaves recent", async () => {
    await testDb.db.insert(authIssueRateBuckets).values([
      // Older than the 2h cushion — stale, drop
      { ip: "203.0.113.10", windowStart: new Date(Date.now() - 3 * 3600 * 1000), count: 5 },
      // Within 2h cushion — keep (still in active 1h window or just recently reset)
      { ip: "203.0.113.11", windowStart: new Date(Date.now() - 30 * 60 * 1000), count: 2 },
      // Just inserted — keep
      { ip: "203.0.113.12", windowStart: new Date(), count: 1 },
    ]);
    const stats = await cleanupTables(testDb.db);
    expect(stats.authIssueRateBucketsDeleted).toBe(1);
    const remaining = await testDb.db.select().from(authIssueRateBuckets);
    expect(remaining.map((r) => r.ip).sort()).toEqual(["203.0.113.11", "203.0.113.12"]);
  });

  test("reports zero counts when tables are empty", async () => {
    const stats = await cleanupTables(testDb.db);
    expect(stats.ssesTicketsDeleted).toBe(0);
    expect(stats.authIssueRateBucketsDeleted).toBe(0);
  });
});
