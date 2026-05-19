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

describe("GET /api/db/tokens/hot", () => {
  test("requires auth", async () => {
    const r = await app.request("/api/db/tokens/hot");
    expect(r.status).toBe(401);
  });

  test("filters by since window", async () => {
    await seedToken({ mint: "FRESH_MINT", priceUsd: 1, mc24hPct: 50, refreshedAgoMin: 30 });
    await seedToken({ mint: "STALE_MINT", priceUsd: 1, mc24hPct: 80, refreshedAgoMin: 60 * 24 });

    const r = await app.request("/api/db/tokens/hot?since=1h", {
      headers: { "X-Auth-Token": token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ mint: string }> };
    expect(body.items.map((i) => i.mint)).toEqual(["FRESH_MINT"]);
  });

  test("filters by minMcChange (5x form)", async () => {
    await seedToken({ mint: "BIG_PUMP", priceUsd: 0.01, mc24hPct: 500, refreshedAgoMin: 5 });
    await seedToken({ mint: "MEH", priceUsd: 0.5, mc24hPct: 12, refreshedAgoMin: 5 });

    const r = await app.request("/api/db/tokens/hot?minMcChange=5x&since=24h", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: Array<{ mint: string }>; minMcChangePct: number };
    // 5x ≡ +400% threshold
    expect(body.minMcChangePct).toBe(400);
    expect(body.items.map((i) => i.mint)).toEqual(["BIG_PUMP"]);
  });

  test("filters by minMcChange (plain percent)", async () => {
    await seedToken({ mint: "A", priceUsd: 1, mc24hPct: 30, refreshedAgoMin: 1 });
    await seedToken({ mint: "B", priceUsd: 1, mc24hPct: 5, refreshedAgoMin: 1 });

    const r = await app.request("/api/db/tokens/hot?minMcChange=20", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: Array<{ mint: string }>; minMcChangePct: number };
    expect(body.minMcChangePct).toBe(20);
    expect(body.items.map((i) => i.mint)).toEqual(["A"]);
  });

  test("respects limit and orders by mc_24h_pct desc", async () => {
    await seedToken({
      mint: "TOP",
      priceUsd: 1,
      mc24hPct: 200,
      liquidityUsd: 1000,
      refreshedAgoMin: 1,
    });
    await seedToken({
      mint: "MID",
      priceUsd: 1,
      mc24hPct: 100,
      liquidityUsd: 1000,
      refreshedAgoMin: 1,
    });
    await seedToken({
      mint: "LOW",
      priceUsd: 1,
      mc24hPct: 50,
      liquidityUsd: 1000,
      refreshedAgoMin: 1,
    });

    const r = await app.request("/api/db/tokens/hot?limit=2&since=24h", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: Array<{ mint: string }> };
    expect(body.items.map((i) => i.mint)).toEqual(["TOP", "MID"]);
  });

  test("excludes rows with NULL price_usd (never refreshed)", async () => {
    await seedToken({ mint: "PRICED", priceUsd: 1, mc24hPct: 50, refreshedAgoMin: 1 });
    await seedToken({ mint: "UNPRICED", priceUsd: null, mc24hPct: 80, refreshedAgoMin: 1 });

    const r = await app.request("/api/db/tokens/hot?since=24h", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items: Array<{ mint: string }> };
    expect(body.items.map((i) => i.mint)).toEqual(["PRICED"]);
  });

  test("returns empty with sane defaults when no rows match", async () => {
    const r = await app.request("/api/db/tokens/hot", { headers: { "X-Auth-Token": token } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[]; sinceMin: number; limit: number };
    expect(body.items).toEqual([]);
    expect(body.sinceMin).toBe(360); // 6h default
    expect(body.limit).toBe(20);
  });
});

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

  test("static /hot route wins over :mint pattern", async () => {
    // Seed a literal "hot" mint to prove `/hot` is matched as the static
    // route, not as :mint = "hot".
    await seedToken({ mint: "hot", priceUsd: 1, mc24hPct: 99, refreshedAgoMin: 1 });
    const r = await app.request("/api/db/tokens/hot", {
      headers: { "X-Auth-Token": token },
    });
    const body = (await r.json()) as { items?: unknown[]; mint?: string };
    // Hot endpoint returns a list payload; single-mint endpoint returns
    // a flat object. Presence of `items` proves the static route fired.
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.mint).toBeUndefined();
  });
});
