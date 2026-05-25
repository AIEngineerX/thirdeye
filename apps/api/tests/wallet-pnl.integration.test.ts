import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

// Hits the real Solana Tracker Data API (no mocks). Skips when the key is
// unset so CI/forks without the secret stay green.
const HAVE_KEY = Boolean(process.env.SOLANATRACKER_API_KEY);
const d = HAVE_KEY ? describe : describe.skip;

// Known high-volume wallet; we assert response shape, never specific values.
const WALLET = "3BqGnroVXCWqBT6LstcLi9qZcDuTB7GuDKHrf8gJnvng";

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  if (!HAVE_KEY) console.log("[skip] SOLANATRACKER_API_KEY not set — wallet-pnl tests skipped");
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe("TRUNCATE auth_tokens RESTART IDENTITY CASCADE;");
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

d("GET /api/wallet/:addr/pnl (real Solana Tracker)", () => {
  test("returns 200 with summary, positions, and trades", async () => {
    const r = await app.request(`/api/wallet/${WALLET}/pnl`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      summary: { summary: { pnl: { realized: number } }; analysis: { winRate: number } };
      positions: unknown[];
      trades: unknown[];
      hasMoreTrades: boolean;
    };
    expect(typeof body.summary.summary.pnl.realized).toBe("number");
    expect(typeof body.summary.analysis.winRate).toBe("number");
    expect(Array.isArray(body.positions)).toBe(true);
    expect(Array.isArray(body.trades)).toBe(true);
    expect(typeof body.hasMoreTrades).toBe("boolean");
  }, 30_000);

  test("rejects an invalid address with 400", async () => {
    const r = await app.request("/api/wallet/not-an-address/pnl", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
  });

  test("requires auth", async () => {
    const r = await app.request(`/api/wallet/${WALLET}/pnl`);
    expect(r.status).toBe(401);
  });
});
