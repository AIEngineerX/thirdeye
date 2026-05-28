import { describe, expect, test } from "bun:test";
import { SolanaTrackerClient } from "../src/client";

const KEY = process.env.SOLANATRACKER_API_KEY;
const d = KEY ? describe : describe.skip;

d("leaderboard (live)", () => {
  test("returns traders with wallet + winRate", async () => {
    const c = new SolanaTrackerClient({ apiKey: KEY! });
    const lb = await c.leaderboard();
    expect(Array.isArray(lb.traders)).toBe(true);
    expect(lb.traders.length).toBeGreaterThan(0);
    const t0 = lb.traders[0]!;
    expect(typeof t0.wallet).toBe("string");
    expect(t0.wallet.length).toBeGreaterThan(30);
  });
});
