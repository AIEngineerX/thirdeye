import { describe, expect, test } from "bun:test";
import { SolanaTrackerClient } from "../src/client";

const KEY = process.env.SOLANATRACKER_API_KEY;
const d = KEY ? describe : describe.skip;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

d("tokenChart (live)", () => {
  test("returns oclhv candles with numeric OHLC + unix-seconds time", async () => {
    const c = new SolanaTrackerClient({ apiKey: KEY! });
    const chart = await c.tokenChart(USDC, "1h");
    expect(Array.isArray(chart.oclhv)).toBe(true);
    expect(chart.oclhv.length).toBeGreaterThan(0);
    const k = chart.oclhv[0]!;
    expect(typeof k.open).toBe("number");
    expect(typeof k.close).toBe("number");
    expect(typeof k.time).toBe("number");
    expect(k.time).toBeGreaterThan(1_000_000_000);
  });
});
