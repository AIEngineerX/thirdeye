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
    const trades = await client.walletTrades(addr);
    return c.json({
      summary,
      positions: positions.positions,
      trades: trades.trades,
      hasMoreTrades: trades.hasNextPage,
    });
  } catch (e) {
    if (e instanceof SolanaTrackerError) {
      // Pass through the meaningful statuses; collapse the rest to 502 so the
      // client never sees a raw upstream 5xx it can't act on.
      const status = e.status === 404 || e.status === 429 ? e.status : 502;
      console.error(`[wallet-pnl ${addr}] solanatracker ${e.status}`, e.message);
      return c.json({ error: "solanatracker_error", message: e.message }, status);
    }
    throw e;
  }
});
