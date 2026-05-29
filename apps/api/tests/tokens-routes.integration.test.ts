import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, tokens } from "@thirdeye/db";
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
  await testDb.sql.unsafe("TRUNCATE auth_tokens, tokens RESTART IDENTITY CASCADE;");
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

async function seedToken(row: {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  priceUsd?: number | null;
  mcUsd?: number | null;
  mc24hPct?: number | null;
  liquidityUsd?: number | null;
  // minutes ago
  refreshedAgoMin?: number;
}): Promise<void> {
  const refreshed = row.refreshedAgoMin ?? 0;
  await testDb.sql.unsafe(
    `INSERT INTO tokens (mint, symbol, name, price_usd, mc_usd, mc_24h_pct, liquidity_usd,
       first_seen_at, last_refreshed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() - ($8::int * interval '1 minute'))`,
    [
      row.mint,
      row.symbol ?? null,
      row.name ?? null,
      row.priceUsd ?? null,
      row.mcUsd ?? null,
      row.mc24hPct ?? null,
      row.liquidityUsd ?? null,
      refreshed,
    ],
  );
}

describe("GET /api/db/tokens/:mint", () => {
  // Real-looking b58 mints. The route now validates with isValidSolanaAddress
  // and 400s on garbage like "not-in-cache" / "KNOWN" (audit L1).
  const VALID_UNKNOWN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const VALID_KNOWN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  test("returns 400 for invalid mint shape (L1)", async () => {
    const r = await app.request("/api/db/tokens/not-in-cache", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_mint");
  });

  test("returns 404 for unknown but well-formed mint", async () => {
    const r = await app.request(`/api/db/tokens/${VALID_UNKNOWN_MINT}`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(404);
  });

  test("returns row for known mint", async () => {
    await seedToken({
      mint: VALID_KNOWN_MINT,
      symbol: "KNW",
      name: "Known Token",
      priceUsd: 0.42,
      mcUsd: 420_000,
      mc24hPct: 17.5,
      liquidityUsd: 50_000,
      refreshedAgoMin: 1,
    });
    const r = await app.request(`/api/db/tokens/${VALID_KNOWN_MINT}`, {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.mint).toBe(VALID_KNOWN_MINT);
    expect(body.symbol).toBe("KNW");
    expect(body.priceUsd).toBe(0.42);
    expect(body.mcUsd).toBe(420_000);
    expect(body.mc24hPct).toBe(17.5);
  });
});
