import { describe, expect, test } from "bun:test";
import { authTokens } from "@thirdeye/db";
import { app } from "../src/index";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb } from "./setup";

const KEY = process.env.SOLANATRACKER_API_KEY;
const d = KEY ? describe : describe.skip;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let t: TestDb;

d("GET /api/db/tokens/:mint/ohlcv", () => {
  test("returns ascending candles + caches (MISS then HIT)", async () => {
    t = await setupTestDb();
    const tk = generateToken();
    await t.db.insert(authTokens).values({ token: tk.token, expiresAt: tk.expiresAt });
    const h = { "X-Auth-Token": tk.token };

    const r1 = await app.request(`/api/db/tokens/${USDC}/ohlcv?type=1h`, { headers: h });
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as { candles: { time: number; close: number }[] };
    expect(body.candles.length).toBeGreaterThan(1);
    expect(body.candles[0]!.time).toBeLessThanOrEqual(body.candles[1]!.time);

    const r2 = await app.request(`/api/db/tokens/${USDC}/ohlcv?type=1h`, { headers: h });
    expect(r2.headers.get("X-ThirdEye-Cache")).toBe("HIT");
    await t.cleanup();
  });
});
