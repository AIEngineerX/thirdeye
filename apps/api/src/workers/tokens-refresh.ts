import { type DbClient, tokens } from "@thirdeye/db";
import { type PriceQuote, type PriceSource, PriceSourceError } from "@thirdeye/prices";
import { inArray, sql } from "drizzle-orm";

// Per-tick refresh budget. Each tick fetches up to TICK_BATCH mints,
// chunked internally by the PriceSource (DexScreener splits at 30/call).
// At 60s cadence this gives us full-table coverage for tracked sets up
// to ~60 mints between scans, which is well past the discovery loop's
// hot-window cap of 10.
const TICK_BATCH = 60;

export interface RefreshOptions {
  source: PriceSource;
  // Override for tests — defaults to TICK_BATCH.
  batchLimit?: number;
}

export interface RefreshStats {
  selected: number;
  refreshed: number;
  errored: number;
}

export async function refreshTokens(db: DbClient, opts: RefreshOptions): Promise<RefreshStats> {
  const limit = opts.batchLimit ?? TICK_BATCH;

  const candidates = await db
    .select({ mint: tokens.mint })
    .from(tokens)
    .orderBy(sql`${tokens.lastRefreshedAt} ASC`)
    .limit(limit);

  if (candidates.length === 0) {
    return { selected: 0, refreshed: 0, errored: 0 };
  }

  const mints = candidates.map((r) => r.mint);
  let quotes: PriceQuote[];
  try {
    quotes = await opts.source.fetch(mints);
  } catch (e) {
    // Source-wide failure — log, leave timestamps untouched so next tick
    // retries the same batch. A persistent outage will not blow up the
    // worker process; graphile-worker will keep firing and we'll backfill
    // when DexScreener is reachable again.
    const msg = e instanceof PriceSourceError ? `${e.source} ${e.status}: ${e.message}` : String(e);
    console.error(`[tokens-refresh] ${msg}`);
    return { selected: candidates.length, refreshed: 0, errored: candidates.length };
  }

  let refreshed = 0;
  for (const q of quotes) {
    await db
      .insert(tokens)
      .values({
        mint: q.mint,
        symbol: q.symbol,
        name: q.name,
        // Drizzle's numeric column accepts string for arbitrary precision;
        // cast undefined/null sensibly. Number-stringification at the
        // boundary keeps storage stable across JS float churn.
        mcUsd: q.mcUsd === null ? null : String(q.mcUsd),
        priceUsd: q.priceUsd === null ? null : String(q.priceUsd),
        mc24hPct: q.mc24hPct === null ? null : String(q.mc24hPct),
        liquidityUsd: q.liquidityUsd === null ? null : String(q.liquidityUsd),
      })
      .onConflictDoUpdate({
        target: tokens.mint,
        set: {
          symbol: sql`COALESCE(EXCLUDED.symbol, ${tokens.symbol})`,
          name: sql`COALESCE(EXCLUDED.name, ${tokens.name})`,
          mcUsd: sql`EXCLUDED.mc_usd`,
          priceUsd: sql`EXCLUDED.price_usd`,
          mc24hPct: sql`EXCLUDED.mc_24h_pct`,
          liquidityUsd: sql`EXCLUDED.liquidity_usd`,
          lastRefreshedAt: sql`now()`,
        },
      });
    refreshed++;
  }

  // Mints we asked for but the source didn't return: still bump
  // last_refreshed_at so we don't hammer the API on an unknown mint
  // every tick. They'll cycle back to the head of the queue normally.
  // (drizzle's inArray() — postgres.js + Bun mishandles raw text[] casts.)
  const returnedSet = new Set(quotes.map((q) => q.mint));
  const missing = mints.filter((m) => !returnedSet.has(m));
  if (missing.length > 0) {
    await db
      .update(tokens)
      .set({ lastRefreshedAt: sql`now()` })
      .where(inArray(tokens.mint, missing));
  }

  return { selected: candidates.length, refreshed, errored: 0 };
}
