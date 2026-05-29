import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

// Use valid 44-char base58 Solana addresses — isValidSolanaAddress requires 32-44 chars.
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const EMPTY_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // valid, no data

let t: TestDb;
beforeEach(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.cleanup();
});

describe("GET /api/db/tokens/:mint/markers", () => {
  test("returns the latest independent signal call point + tracked buys", async () => {
    const tk = generateToken();
    await t.db.insert(authTokens).values({ token: tk.token, expiresAt: tk.expiresAt });
    await t.sql`INSERT INTO signals (mint, wallet_count, wallets, trust, ath_multiplier, first_buy_at, detected_at)
      VALUES (${MINT}, 2, '["W1","W2"]'::jsonb, 'independent', 3.5, now(), now())`;
    await t.sql`INSERT INTO smart_trades (wallet, mint, side, signature, traded_at)
      VALUES ('W1', ${MINT}, 'buy', 'sigA', now()), ('W2', ${MINT}, 'buy', 'sigB', now())`;

    const r = await app.request(`/api/db/tokens/${MINT}/markers`, {
      headers: { "X-Auth-Token": tk.token },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      call: { time: number; multiplier: number | null } | null;
      buys: { time: number }[];
    };
    expect(body.call).not.toBeNull();
    expect(body.call!.multiplier).toBeCloseTo(3.5, 5);
    expect(typeof body.call!.time).toBe("number");
    expect(body.buys.length).toBe(2);
  });

  test("no signal → call null, buys empty", async () => {
    const tk = generateToken();
    await t.db.insert(authTokens).values({ token: tk.token, expiresAt: tk.expiresAt });
    const r = await app.request(`/api/db/tokens/${EMPTY_MINT}/markers`, {
      headers: { "X-Auth-Token": tk.token },
    });
    const body = (await r.json()) as { call: unknown; buys: unknown[] };
    expect(body.call).toBeNull();
    expect(body.buys).toEqual([]);
  });
});
