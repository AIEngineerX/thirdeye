import { describe, expect, test } from "bun:test";
import { SolanaTrackerClient, SolanaTrackerError } from "../src";

// Integration tests hit the real Solana Tracker Data API — no mocks, per repo
// policy. They skip cleanly when SOLANATRACKER_API_KEY is unset so fork PRs and
// CI without the secret stay green. When set, they exercise the live endpoints.
const KEY = process.env.SOLANATRACKER_API_KEY;
const d = KEY ? describe : describe.skip;
if (!KEY)
  console.log("[skip] SOLANATRACKER_API_KEY not set — Solana Tracker integration tests skipped");

// A known high-volume wallet (top of the traders leaderboard at capture time).
// We assert response *shape*, never specific values, so churn in its trading
// doesn't break the suite.
const WALLET = "3BqGnroVXCWqBT6LstcLi9qZcDuTB7GuDKHrf8gJnvng";
const TIMEOUT = 30_000;

d("SolanaTrackerClient — live Data API", () => {
  const client = new SolanaTrackerClient({ apiKey: KEY as string });

  test(
    "walletPnl returns a typed PnL summary",
    async () => {
      const r = await client.walletPnl(WALLET);
      expect(r.wallet).toBe(WALLET);
      expect(typeof r.pnlMode).toBe("string");
      expect(typeof r.summary.pnl.realized).toBe("number");
      expect(typeof r.summary.pnl.unrealized).toBe("number");
      expect(typeof r.summary.pnl.total).toBe("number");
      expect(typeof r.summary.roi).toBe("number");
      expect(typeof r.summary.counts.trades).toBe("number");
      expect(typeof r.analysis.winRate).toBe("number");
    },
    TIMEOUT,
  );

  test(
    "walletPositions returns an array of per-token positions",
    async () => {
      const r = await client.walletPositions(WALLET);
      expect(Array.isArray(r.positions)).toBe(true);
      const p = r.positions[0];
      expect(p).toBeDefined();
      if (p) {
        expect(typeof p.token).toBe("string");
        expect(typeof p.pnl.total).toBe("number");
        expect(typeof p.current.costBasis).toBe("number");
        expect(typeof p.meta.symbol).toBe("string");
      }
    },
    TIMEOUT,
  );

  test(
    "walletPerformance returns a windowed series",
    async () => {
      const r = await client.walletPerformance(WALLET);
      expect(typeof r.window).toBe("number");
      expect(typeof r.totals.realizedPnl).toBe("number");
      expect(Array.isArray(r.days)).toBe(true);
      expect(typeof r.streaks.positive).toBe("number");
    },
    TIMEOUT,
  );

  test(
    "walletTrades returns paginated trades with cursor",
    async () => {
      const r = await client.walletTrades(WALLET);
      expect(Array.isArray(r.trades)).toBe(true);
      expect(typeof r.hasNextPage).toBe("boolean");
      const t = r.trades[0];
      expect(t).toBeDefined();
      if (t) {
        expect(typeof t.tx).toBe("string");
        expect(typeof t.from.address).toBe("string");
        expect(typeof t.to.address).toBe("string");
        expect(typeof t.volume.usd).toBe("number");
        expect(typeof t.time).toBe("number");
      }
    },
    TIMEOUT,
  );

  test(
    "non-2xx responses throw SolanaTrackerError with the status",
    async () => {
      const bad = new SolanaTrackerClient({ apiKey: "definitely-not-a-valid-key" });
      let thrown: unknown;
      try {
        await bad.walletPnl(WALLET);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SolanaTrackerError);
      expect((thrown as SolanaTrackerError).status).toBeGreaterThanOrEqual(400);
    },
    TIMEOUT,
  );
});
