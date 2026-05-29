import { SolanaTrackerClient, SolanaTrackerError } from "@thirdeye/solanatracker";
import { Hono } from "hono";
import { env } from "../../env";
import { isValidSolanaAddress } from "../../lib/solana-address";

export const walletPnl = new Hono();

/**
 * GET /api/wallet/:addr/pnl — wallet trading performance from Solana Tracker.
 *
 * Returns realized/unrealized PnL, per-token positions, and recent trades.
 * Calls are sequenced (not Promise.all) because the free tier rate-limits
 * bursts; the client retries 429 with backoff but sequencing avoids the
 * latency of paying that tax three times on a single page load.
 */
walletPnl.get("/:addr/pnl", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    return c.json({ error: "invalid_address", message: "Address is not valid base58" }, 400);
  }
  if (!env.SOLANATRACKER_API_KEY) {
    return c.json(
      { error: "not_configured", message: "SOLANATRACKER_API_KEY is not set on the server" },
      503,
    );
  }

  const client = new SolanaTrackerClient({ apiKey: env.SOLANATRACKER_API_KEY });
  try {
    const summary = await client.walletPnl(addr);
    const positions = await client.walletPositions(addr);
    const performance = await client.walletPerformance(addr);
    const trades = await client.walletTrades(addr);
    return c.json({
      summary,
      positions: positions.positions,
      performance,
      trades: trades.trades,
      hasMoreTrades: trades.hasNextPage,
    });
  } catch (e) {
    if (e instanceof SolanaTrackerError) {
      // Curate the client-facing message — the raw SolanaTrackerError carries
      // the upstream URL + a slice of the upstream body, which is internal
      // detail the browser shouldn't see (matches the Helius L3 sanitization).
      // Full error stays in the server log.
      console.error(`[wallet-pnl ${addr}] solanatracker ${e.status}: ${e.message}`);
      if (e.status === 404) {
        return c.json({ error: "not_found", message: "No trading history for this wallet" }, 404);
      }
      if (e.status === 429) {
        return c.json(
          { error: "rate_limited", message: "Upstream rate limit — try again shortly" },
          429,
        );
      }
      return c.json({ error: "upstream_error", message: "Could not load wallet data" }, 502);
    }
    throw e;
  }
});
