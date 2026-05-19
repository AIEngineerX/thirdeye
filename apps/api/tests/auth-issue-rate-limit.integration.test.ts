// H2: POST /api/db/auth must rate-limit token issuance per IP under
// PUBLIC_INSTANCE_MODE. Without this, per-token limits on other routes
// can be defeated by minting a fresh token before each block.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { tryAuthIssue } from "../src/lib/auth-issue-rate-limit";
import { type TestDb, setupTestDb } from "./setup";

let testDb: TestDb;
const ORIGINAL_MODE = process.env.PUBLIC_INSTANCE_MODE;
const ORIGINAL_LIMIT = process.env.AUTH_ISSUE_LIMIT_PER_HOUR;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(() => {
  testDb.cleanup();
  // env.ts is evaluated at module load, so we can't change limits mid-run
  // — restore PUBLIC_INSTANCE_MODE so other tests see the original value.
  if (ORIGINAL_MODE === undefined) process.env.PUBLIC_INSTANCE_MODE = undefined;
  else process.env.PUBLIC_INSTANCE_MODE = ORIGINAL_MODE;
  if (ORIGINAL_LIMIT === undefined) process.env.AUTH_ISSUE_LIMIT_PER_HOUR = undefined;
  else process.env.AUTH_ISSUE_LIMIT_PER_HOUR = ORIGINAL_LIMIT;
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, auth_issue_rate_buckets RESTART IDENTITY CASCADE;",
  );
});

describe("tryAuthIssue (unit-ish, hits real DB)", () => {
  test("admits up to the limit then denies further", async () => {
    const ip = "203.0.113.42";
    for (let i = 0; i < 3; i++) {
      const r = await tryAuthIssue(testDb.db, { ip, limit: 3, windowSec: 3600 });
      expect(r.ok).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const blocked = await tryAuthIssue(testDb.db, { ip, limit: 3, windowSec: 3600 });
    expect(blocked.ok).toBe(false);
    expect(blocked.count).toBe(4);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("two distinct IPs have independent buckets", async () => {
    for (let i = 0; i < 3; i++) {
      await tryAuthIssue(testDb.db, { ip: "203.0.113.1", limit: 3, windowSec: 3600 });
    }
    const otherIp = await tryAuthIssue(testDb.db, {
      ip: "203.0.113.2",
      limit: 3,
      windowSec: 3600,
    });
    expect(otherIp.ok).toBe(true);
    expect(otherIp.count).toBe(1);
  });

  test("window expiry resets count", async () => {
    const ip = "203.0.113.99";
    // Use a 1-second window so we can wait it out.
    await tryAuthIssue(testDb.db, { ip, limit: 1, windowSec: 1 });
    const r1 = await tryAuthIssue(testDb.db, { ip, limit: 1, windowSec: 1 });
    expect(r1.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 1100));
    const r2 = await tryAuthIssue(testDb.db, { ip, limit: 1, windowSec: 1 });
    expect(r2.ok).toBe(true);
    expect(r2.count).toBe(1);
  });
});

describe("POST /api/db/auth IP rate-limit integration", () => {
  test("PUBLIC_INSTANCE_MODE=false: no per-IP gate (existing behavior)", async () => {
    process.env.PUBLIC_INSTANCE_MODE = "false";
    for (let i = 0; i < 15; i++) {
      const r = await app.request("/api/db/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(200);
    }
    const rows = await testDb.db.select().from(authTokens);
    expect(rows.length).toBe(15);
  });

  test("PUBLIC_INSTANCE_MODE=true: caller IP gets 429 after the limit", async () => {
    process.env.PUBLIC_INSTANCE_MODE = "true";
    // env.AUTH_ISSUE_LIMIT_PER_HOUR was 10 at module load (default). We
    // expect 10 successes then a 429.
    const ip = "198.51.100.5";
    let lastBody: { error?: string; retryAfterSec?: number } | undefined;
    let firstBlocked = -1;
    for (let i = 0; i < 12; i++) {
      const r = await app.request("/api/db/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: "{}",
      });
      if (r.status === 429) {
        if (firstBlocked === -1) firstBlocked = i;
        lastBody = (await r.json()) as typeof lastBody;
      }
    }
    expect(firstBlocked).toBe(10);
    expect(lastBody?.error).toBe("auth_issue_rate_limited");
    expect(lastBody?.retryAfterSec).toBeGreaterThan(0);

    const rows = await testDb.db.select().from(authTokens);
    expect(rows.length).toBe(10);
  });

  test("PUBLIC_INSTANCE_MODE=true: distinct IPs each get the full quota", async () => {
    process.env.PUBLIC_INSTANCE_MODE = "true";
    for (let i = 0; i < 8; i++) {
      const r1 = await app.request("/api/db/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.6" },
        body: "{}",
      });
      const r2 = await app.request("/api/db/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.7" },
        body: "{}",
      });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    }
  });
});
