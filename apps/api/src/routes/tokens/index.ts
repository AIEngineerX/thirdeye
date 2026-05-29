import { type DbClient, tokens } from "@thirdeye/db";
import { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { env } from "../../env";
import { toIso } from "../../lib/http";
import { isValidSolanaAddress } from "../../lib/solana-address";

type Variables = { db: DbClient };

export const tokensRoutes = new Hono<{ Variables: Variables }>();

interface OhlcvOut {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
const ohlcvCache = new Map<string, { at: number; candles: OhlcvOut[] }>();
const OHLCV_TTL_MS = 60_000;

export function _resetOhlcvCache(): void {
  ohlcvCache.clear();
}

// IMPORTANT — register `/:mint/ohlcv` BEFORE the bare `/:mint` route: Hono
// matches in declaration order. Without this ordering, a request to
// `/:mint/ohlcv` would be captured by the `/:mint` pattern with
// mint="<addr>" and never reach this handler.
tokensRoutes.get("/:mint/ohlcv", async (c) => {
  const mint = c.req.param("mint");
  const type = c.req.query("type") ?? "1h";
  if (!isValidSolanaAddress(mint)) return c.json({ error: "invalid_mint" }, 400);
  if (!env.SOLANATRACKER_API_KEY) return c.json({ error: "ohlcv_unconfigured" }, 503);
  const key = `${mint}:${type}`;
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < OHLCV_TTL_MS) {
    return c.json({ candles: hit.candles }, 200, { "X-ThirdEye-Cache": "HIT" });
  }
  const client = new SolanaTrackerClient({ apiKey: env.SOLANATRACKER_API_KEY });
  const chart = await client.tokenChart(mint, type);
  const candles: OhlcvOut[] = chart.oclhv
    .map((k) => ({
      time: k.time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }))
    .sort((a, b) => a.time - b.time);
  ohlcvCache.set(key, { at: Date.now(), candles });
  return c.json({ candles }, 200, { "X-ThirdEye-Cache": "MISS" });
});

// IMPORTANT — register `/:mint/markers` BEFORE `/:mint` for the same reason
// as `/:mint/ohlcv`: Hono matches in declaration order.
tokensRoutes.get("/:mint/markers", async (c) => {
  const mint = c.req.param("mint");
  if (!isValidSolanaAddress(mint)) return c.json({ error: "invalid_mint" }, 400);
  const db = c.get("db");
  const sigRows = (await db.execute(sql`
    SELECT extract(epoch FROM detected_at)::bigint AS t, ath_multiplier AS m
    FROM signals WHERE mint = ${mint} AND trust = 'independent'
    ORDER BY detected_at DESC LIMIT 1
  `)) as unknown as Array<{ t: string | number; m: string | null }>;
  const buyRows = (await db.execute(sql`
    SELECT extract(epoch FROM traded_at)::bigint AS t
    FROM smart_trades WHERE mint = ${mint} AND side = 'buy'
    ORDER BY traded_at DESC LIMIT 50
  `)) as unknown as Array<{ t: string | number }>;
  const call = sigRows[0]
    ? {
        time: Number(sigRows[0].t),
        multiplier: sigRows[0].m === null ? null : Number(sigRows[0].m),
      }
    : null;
  return c.json({ call, buys: buyRows.map((r) => ({ time: Number(r.t) })) });
});

tokensRoutes.get("/:mint", async (c) => {
  const mint = c.req.param("mint");
  // L1 (audit): match the validation pattern used on every other
  // parameterized route. Garbage mints used to hit the DB pointlessly;
  // now they 400 before the query runs.
  if (!isValidSolanaAddress(mint)) {
    return c.json({ error: "invalid_mint" }, 400);
  }
  const db = c.get("db");
  const rows = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not_found", message: "Token not in cache" }, 404);
  return c.json(serialize(row));
});

type TokenRow = typeof tokens.$inferSelect;

function serialize(row: TokenRow) {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    priceUsd: row.priceUsd === null ? null : Number(row.priceUsd),
    mcUsd: row.mcUsd === null ? null : Number(row.mcUsd),
    mc24hPct: row.mc24hPct === null ? null : Number(row.mc24hPct),
    liquidityUsd: row.liquidityUsd === null ? null : Number(row.liquidityUsd),
    firstSeenAt: toIso(row.firstSeenAt),
    lastRefreshedAt: toIso(row.lastRefreshedAt),
  };
}
