import type { DbClient } from "@thirdeye/db";
import { type PriceQuote, type PriceSource, PriceSourceError } from "@thirdeye/prices";
import { computeOutcome } from "@thirdeye/scanner";
import { sql } from "drizzle-orm";
import { publish } from "../lib/intel-bus";
import { recomputeWalletAttribution } from "../lib/signals";

// Open signals are cheap to follow; cap per tick to bound the DexScreener
// batch. At 60s cadence this covers far more than the number of signals open
// in any realistic window.
const TICK_BATCH = 60;
const SAFE_DELAY_MIN = 3; // re-snapshot the conservative base after this age

export interface RefreshSignalsOptions {
  source: PriceSource;
  hitMultiplier: number;
  closeAfterHours: number;
  batchLimit?: number;
}

export interface RefreshSignalsStats {
  selected: number;
  updated: number;
  closed: number;
  errored: number;
}

interface OpenRow {
  id: number;
  mint: string;
  call_mc: string | null;
  safe_call_mc: string | null;
  ath_mc: string | null;
  detected_at: string;
  symbol: string | null;
  wallets: string[];
  age_min: number;
}

export async function refreshSignals(
  db: DbClient,
  opts: RefreshSignalsOptions,
): Promise<RefreshSignalsStats> {
  const limit = opts.batchLimit ?? TICK_BATCH;

  const open = (await db.execute(sql`
    SELECT id, mint, call_mc, safe_call_mc, ath_mc, detected_at, symbol, wallets,
           EXTRACT(EPOCH FROM (now() - detected_at)) / 60 AS age_min
    FROM signals
    WHERE status = 'open'
    ORDER BY detected_at ASC
    LIMIT ${limit}
  `)) as unknown as OpenRow[];

  if (open.length === 0) return { selected: 0, updated: 0, closed: 0, errored: 0 };

  const mints = [...new Set(open.map((r) => r.mint))];
  let quotes: PriceQuote[];
  try {
    quotes = await opts.source.fetch(mints);
  } catch (e) {
    const msg = e instanceof PriceSourceError ? `${e.source} ${e.status}: ${e.message}` : String(e);
    console.error(`[signals-refresh] ${msg}`);
    return { selected: open.length, updated: 0, closed: 0, errored: open.length };
  }
  const mcByMint = new Map<string, number | null>();
  for (const q of quotes) mcByMint.set(q.mint, q.mcUsd);

  let updated = 0;
  let closed = 0;
  let errored = 0;
  const closedWallets = new Set<string>();

  for (const r of open) {
    try {
      const currentMc = mcByMint.has(r.mint) ? mcByMint.get(r.mint)! : null;
      const callMc = r.call_mc !== null ? Number(r.call_mc) : null;
      const ageMin = Number(r.age_min);

      // Set the conservative base once, after SAFE_DELAY_MIN.
      const safeCallMc =
        r.safe_call_mc !== null
          ? Number(r.safe_call_mc)
          : ageMin >= SAFE_DELAY_MIN && currentMc !== null
            ? currentMc
            : null;
      const setSafe = r.safe_call_mc === null && safeCallMc !== null;

      const outcome = computeOutcome({
        callMc,
        safeCallMc,
        currentMc,
        priorAthMc: r.ath_mc !== null ? Number(r.ath_mc) : null,
        hitMultiplier: opts.hitMultiplier,
      });

      const shouldClose = ageMin >= opts.closeAfterHours * 60;

      await db.execute(sql`
        UPDATE signals SET
          current_mc = ${currentMc !== null ? currentMc : sql`current_mc`},
          ath_mc = ${outcome.athMc},
          ath_multiplier = ${outcome.athMultiplier},
          safe_ath_multiplier = ${outcome.safeAthMultiplier},
          is_hit = ${outcome.isHit},
          safe_is_hit = ${outcome.safeIsHit},
          peak_at = ${outcome.newPeak ? sql`now()` : sql`peak_at`},
          safe_call_mc = ${setSafe ? safeCallMc : sql`safe_call_mc`},
          safe_promoted_at = ${setSafe ? sql`now()` : sql`safe_promoted_at`},
          status = ${shouldClose ? "closed" : "open"}
        WHERE id = ${r.id}
      `);
      updated++;

      await publish({
        event: "smartmoney:outcome",
        data: {
          id: r.id,
          mint: r.mint,
          symbol: r.symbol,
          currentMc,
          athMultiplier: outcome.athMultiplier,
          safeAthMultiplier: outcome.safeAthMultiplier,
          isHit: outcome.isHit,
          status: shouldClose ? "closed" : "open",
        },
      });

      if (shouldClose) {
        closed++;
        for (const w of r.wallets) closedWallets.add(w);
      }
    } catch (e) {
      errored++;
      console.error(`[signals-refresh] update failed id=${r.id}`, e);
    }
  }

  // Attribute closed signals back to their wallets in one pass.
  if (closedWallets.size > 0) {
    try {
      await recomputeWalletAttribution(db, [...closedWallets]);
    } catch (e) {
      console.error("[signals-refresh] attribution recompute failed", e);
    }
  }

  return { selected: open.length, updated, closed, errored };
}
