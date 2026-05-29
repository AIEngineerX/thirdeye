import { type DbClient, tokens } from "@thirdeye/db";
import { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { env } from "../../env";
import { clampInt, toIso } from "../../lib/http";
import { isValidSolanaAddress } from "../../lib/solana-address";

type Variables = { db: DbClient };

export const tokensRoutes = new Hono<{ Variables: Variables }>();

// `since` parameter parser. Accepts forms like 1h, 6h, 24h, 7d, 30m.
// Anything unparseable falls back to the default. We intentionally
// only support the exact suffixes the spec calls out — yagni on
// composite formats like "1h30m".
function parseSince(raw: string | undefined, fallbackMin: number): number {
  if (!raw) return fallbackMin;
  const m = /^(\d+)\s*(m|h|d)$/.exec(raw.trim());
  if (!m) return fallbackMin;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return fallbackMin;
  const unit = m[2]!;
  if (unit === "m") return n;
  if (unit === "h") return n * 60;
  return n * 60 * 24;
}

// `minMcChange` is documented as "5x" in the spec — a multiplier shorthand
// where 5x ≡ +400% in 24h. Accept that form and a plain percent number.
function parseMinMcChange(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const x = /^(\d+(?:\.\d+)?)x$/i.exec(trimmed);
  if (x) {
    const n = Number.parseFloat(x[1]!);
    return Number.isFinite(n) ? (n - 1) * 100 : null;
  }
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

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

// IMPORTANT — register `/hot` BEFORE `/:mint` so the static segment
// match wins routing precedence. Hono evaluates registered routes in
// declaration order; flipping these would let `:mint = "hot"` capture
// the request and the static handler would never fire.
tokensRoutes.get("/hot", async (c) => {
  const sinceMin = parseSince(c.req.query("since"), 6 * 60); // default: last 6h
  const minPct = parseMinMcChange(c.req.query("minMcChange"));
  const limit = clampInt(c.req.query("limit"), 20, 1, 100);
  const db = c.get("db");

  const conditions: ReturnType<typeof sql>[] = [
    sql`${tokens.lastRefreshedAt} >= now() - (${sinceMin}::int * interval '1 minute')`,
    sql`${tokens.priceUsd} IS NOT NULL`,
  ];
  if (minPct !== null) {
    conditions.push(sql`${tokens.mc24hPct} >= ${minPct}`);
  }

  const where = conditions.reduce(
    (acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`),
    sql``,
  );

  const rows = await db
    .select()
    .from(tokens)
    .where(where)
    .orderBy(sql`${tokens.mc24hPct} DESC NULLS LAST, ${tokens.liquidityUsd} DESC NULLS LAST`)
    .limit(limit);

  return c.json({
    items: rows.map(serialize),
    sinceMin,
    minMcChangePct: minPct,
    limit,
  });
});

// IMPORTANT — register `/:mint/ohlcv` BEFORE `/:mint` for the same reason
// `/hot` is registered before `/:mint`: Hono matches in declaration order.
// Without this ordering, a request to `/:mint/ohlcv` would be captured by
// the bare `/:mint` pattern with mint="<addr>" and never reach this handler.
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
