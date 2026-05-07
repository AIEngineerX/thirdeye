import { describe, expect, test } from "bun:test";
import { DexScreenerSource } from "../src/dexscreener";

// USDC on Solana — guaranteed to be in DexScreener with stable data.
// Used for the optional live test below; if DexScreener is reachable
// from the test environment this asserts end-to-end parsing on real
// JSON. CI environments without outbound network skip cleanly.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const REACHABLE = await dexScreenerReachable();

async function dexScreenerReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://api.dexscreener.com/", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

describe("DexScreenerSource — fixture-driven", () => {
  test("collapses multiple pairs to deepest-liquidity per mint", async () => {
    const fixture = [
      {
        chainId: "solana",
        baseToken: { address: "MINT_A", symbol: "A", name: "TokenA" },
        priceUsd: "1.50",
        fdv: 1_500_000,
        liquidity: { usd: 50_000 },
        priceChange: { h24: 12.5 },
      },
      {
        chainId: "solana",
        baseToken: { address: "MINT_A", symbol: "A", name: "TokenA" },
        priceUsd: "1.49",
        fdv: 1_490_000,
        // higher liquidity — should win
        liquidity: { usd: 200_000 },
        priceChange: { h24: 11.0 },
      },
      {
        chainId: "solana",
        baseToken: { address: "MINT_B", symbol: "B", name: "TokenB" },
        priceUsd: "0.001",
        marketCap: 10_000,
        liquidity: { usd: 5_000 },
        priceChange: { h24: -3.2 },
      },
    ];

    const source = new DexScreenerSource({
      fetchImpl: async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const quotes = await source.fetch(["MINT_A", "MINT_B"]);
    expect(quotes).toHaveLength(2);

    const a = quotes.find((q) => q.mint === "MINT_A");
    expect(a).toBeDefined();
    expect(a?.priceUsd).toBe(1.49);
    expect(a?.liquidityUsd).toBe(200_000);
    expect(a?.mc24hPct).toBe(11.0);
    expect(a?.mcUsd).toBe(1_490_000);

    const b = quotes.find((q) => q.mint === "MINT_B");
    // marketCap takes precedence over fdv when present
    expect(b?.mcUsd).toBe(10_000);
    expect(b?.mc24hPct).toBe(-3.2);
  });

  test("dedups input mints before batching", async () => {
    let callCount = 0;
    const source = new DexScreenerSource({
      fetchImpl: async (url: string) => {
        callCount++;
        // 30 mints per call; with dedup we should see 1 call, not 2
        const u = new URL(url);
        const path = u.pathname;
        const list = path.slice(path.lastIndexOf("/") + 1).split(",");
        expect(list.length).toBeLessThanOrEqual(30);
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    await source.fetch(["A", "B", "A", "C", "B"]);
    expect(callCount).toBe(1);
  });

  test("batches at 30 mints per call", async () => {
    const calls: string[][] = [];
    const source = new DexScreenerSource({
      fetchImpl: async (url: string) => {
        const path = new URL(url).pathname;
        const list = path.slice(path.lastIndexOf("/") + 1).split(",");
        calls.push(list);
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    const mints = Array.from({ length: 65 }, (_, i) => `MINT_${i}`);
    await source.fetch(mints);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toHaveLength(30);
    expect(calls[1]).toHaveLength(30);
    expect(calls[2]).toHaveLength(5);
  });

  test("surfaces non-2xx responses as PriceSourceError", async () => {
    const source = new DexScreenerSource({
      fetchImpl: async () => new Response("server error", { status: 502 }),
    });
    await expect(source.fetch(["MINT_A"])).rejects.toThrow(/502/);
  });

  test("returns empty for empty input without HTTP call", async () => {
    let called = false;
    const source = new DexScreenerSource({
      fetchImpl: async () => {
        called = true;
        return new Response("[]");
      },
    });
    expect(await source.fetch([])).toEqual([]);
    expect(called).toBe(false);
  });

  test("tolerates {pairs:[...]} alternate shape", async () => {
    const source = new DexScreenerSource({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            pairs: [
              {
                baseToken: { address: "MINT_X", symbol: "X", name: "X" },
                priceUsd: "5.00",
                fdv: 5_000_000,
                liquidity: { usd: 100_000 },
                priceChange: { h24: 50 },
              },
            ],
          }),
        ),
    });
    const quotes = await source.fetch(["MINT_X"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.priceUsd).toBe(5.0);
  });
});

(REACHABLE ? describe : describe.skip)("DexScreenerSource — live", () => {
  test("fetches USDC successfully", async () => {
    const source = new DexScreenerSource();
    const quotes = await source.fetch([USDC_MINT]);
    expect(quotes.length).toBeGreaterThan(0);
    const usdc = quotes.find((q) => q.mint === USDC_MINT);
    expect(usdc).toBeDefined();
    // USDC trades within 0.99..1.01 even in chaotic markets
    expect(usdc?.priceUsd).toBeGreaterThan(0.95);
    expect(usdc?.priceUsd).toBeLessThan(1.05);
    expect(usdc?.liquidityUsd).toBeGreaterThan(0);
  }, 15_000);
});
