import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { buildDashboard } from "../src/lib/dashboard";
import { generateToken } from "../src/lib/tokens";
import { _resetDashboardCache } from "../src/routes/dashboard";
import { type TestDb, setupTestDb } from "./setup";

let t: TestDb;

beforeEach(async () => {
  t = await setupTestDb();
  _resetDashboardCache();
});

afterAll(async () => {
  if (t) await t.cleanup();
});

describe("buildDashboard — stats", () => {
  test("excludes co_funded from stats + live_signals; counts only independent", async () => {
    // independent HIT signal
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintAAA', 'AAA', 2, '["W1","W2"]'::jsonb, 'independent', 50000, 3, true, 'closed', now(), now());
    `);
    // independent OPEN signal
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintBBB', 'BBB', 1, '["W3"]'::jsonb, 'independent', 20000, 1.2, false, 'open', now() - interval '1 minute', now() - interval '1 minute');
    `);
    // co_funded signal — must be excluded from stats and live_signals
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintCOF', 'COF', 3, '["W4","W5","W6"]'::jsonb, 'co_funded', 10000, 99, true, 'closed', now(), now());
    `);

    const bundle = await buildDashboard(t.db);

    // stats excludes co_funded
    expect(bundle.stats.total_signals).toBe(2);
    expect(bundle.stats.hits).toBe(1);
    expect(bundle.stats.hit_rate).toBe(0.5);
    expect(bundle.stats.open_signals).toBe(1);

    // best_multiplier is 3 (from AAA), NOT 99 (co_funded)
    expect(bundle.stats.best_multiplier).toBe(3);
    expect(bundle.stats.best_multiplier_symbol).toBe("AAA");
  });

  test("hit_rate is 0 when total_signals is 0", async () => {
    const bundle = await buildDashboard(t.db);
    expect(bundle.stats.total_signals).toBe(0);
    expect(bundle.stats.hit_rate).toBe(0);
    expect(bundle.stats.best_multiplier).toBeNull();
    expect(bundle.stats.best_multiplier_symbol).toBeNull();
  });
});

describe("buildDashboard — live_signals", () => {
  test("returns newest first, length 2, excludes co_funded", async () => {
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintAAA', 'AAA', 2, '["W1","W2"]'::jsonb, 'independent', 50000, 3, true, 'closed', now(), now());
    `);
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintBBB', 'BBB', 1, '["W3"]'::jsonb, 'independent', 20000, 1.2, false, 'open', now() - interval '1 minute', now() - interval '1 minute');
    `);
    await t.sql.unsafe(`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, ath_multiplier, is_hit, status, first_buy_at, detected_at)
      VALUES ('MintCOF', 'COF', 3, '["W4","W5","W6"]'::jsonb, 'co_funded', 10000, 99, true, 'closed', now(), now());
    `);

    const bundle = await buildDashboard(t.db);

    expect(bundle.live_signals.length).toBe(2);
    // newest first: AAA was inserted with now(), BBB with now() - 1 minute
    expect(bundle.live_signals[0]!.symbol).toBe("AAA");
    expect(bundle.live_signals[1]!.symbol).toBe("BBB");
    // no co_funded entries
    expect(bundle.live_signals.every((s) => s.trust !== "co_funded")).toBe(true);
  });
});

describe("buildDashboard — trending", () => {
  test("returns tokens with recent last_refreshed_at and mc_24h_pct", async () => {
    await t.sql.unsafe(`
      INSERT INTO tokens (mint, symbol, name, mc_usd, price_usd, mc_24h_pct, liquidity_usd, last_refreshed_at)
      VALUES ('MintTK1', 'TK1', 'Token One', 1000000, 0.01, 15, 500000, now());
    `);

    const bundle = await buildDashboard(t.db);

    expect(bundle.trending.length).toBe(1);
    expect(bundle.trending[0]!.mint).toBe("MintTK1");
    expect(bundle.trending[0]!.mc_24h_pct).toBe(15);
  });

  test("excludes tokens with stale last_refreshed_at", async () => {
    await t.sql.unsafe(`
      INSERT INTO tokens (mint, symbol, name, mc_usd, price_usd, mc_24h_pct, liquidity_usd, last_refreshed_at)
      VALUES ('MintSTALE', 'STL', 'Stale Token', 500000, 0.005, 20, 100000, now() - interval '25 hours');
    `);

    const bundle = await buildDashboard(t.db);
    expect(bundle.trending.length).toBe(0);
  });
});

describe("buildDashboard — top_traders", () => {
  test("returns tracked wallets ordered by signal_winrate desc", async () => {
    await t.sql.unsafe(`
      INSERT INTO tracked_wallets (address, label, signal_wins, signal_signals, signal_winrate, realized_pnl_usd)
      VALUES ('WalletAlpha111111111111111111111111111111111', 'alpha', 4, 5, 0.8, 12345.67);
    `);

    const bundle = await buildDashboard(t.db);

    expect(bundle.top_traders.length).toBe(1);
    expect(bundle.top_traders[0]!.address).toBe("WalletAlpha111111111111111111111111111111111");
    expect(bundle.top_traders[0]!.signal_winrate).toBe(0.8);
    expect(bundle.top_traders[0]!.signal_wins).toBe(4);
    expect(bundle.top_traders[0]!.signal_signals).toBe(5);
  });
});

describe("GET /api/db/dashboard — route", () => {
  let token: string;

  beforeEach(async () => {
    _resetDashboardCache();
    const tkn = generateToken();
    await t.db.insert(authTokens).values({ token: tkn.token, expiresAt: tkn.expiresAt });
    token = tkn.token;
  });

  test("first request → X-ThirdEye-Cache: MISS; second → HIT", async () => {
    const r1 = await app.request("/api/db/dashboard", {
      headers: { "X-Auth-Token": token },
    });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("X-ThirdEye-Cache")).toBe("MISS");

    const body1 = (await r1.json()) as { stats: { total_signals: number }; generated_at: string };
    expect(typeof body1.stats.total_signals).toBe("number");
    expect(typeof body1.generated_at).toBe("string");

    const r2 = await app.request("/api/db/dashboard", {
      headers: { "X-Auth-Token": token },
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-ThirdEye-Cache")).toBe("HIT");
  });

  test("without auth token → 401", async () => {
    const r = await app.request("/api/db/dashboard");
    expect(r.status).toBe(401);
  });
});
