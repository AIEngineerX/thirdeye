import type { DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

export interface PromoteArgs {
  mint: string;
  symbol: string | null;
  wallets: string[];
  firstBuyAtMs: number;
  callMc: number | null;
  callPrice: number | null;
}

// Upsert the single OPEN signal for a mint. First independent confluence
// inserts with the call snapshot; later confluences on the still-open mint
// update the wallet set/count only (the call snapshot is immutable — it is
// the entry price we are scored against). The upsert always returns its row.
export async function promoteOrUpdateSignal(db: DbClient, a: PromoteArgs): Promise<number> {
  const walletsJson = JSON.stringify(a.wallets);
  const firstBuyIso = new Date(a.firstBuyAtMs).toISOString();
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO signals
      (mint, symbol, wallet_count, wallets, trust, call_mc, call_price, first_buy_at)
    VALUES (
      ${a.mint}, ${a.symbol}, ${a.wallets.length}, ${walletsJson}::jsonb, 'independent',
      ${a.callMc}, ${a.callPrice}, ${firstBuyIso}
    )
    ON CONFLICT (mint) WHERE status = 'open'
    DO UPDATE SET
      wallet_count = EXCLUDED.wallet_count,
      wallets = EXCLUDED.wallets,
      symbol = COALESCE(EXCLUDED.symbol, signals.symbol)
    RETURNING id
  `);
  // postgres.js returns bigserial as a string; coerce so the declared
  // number return type (and the smartmoney:signal event) is truthful.
  const [row] = rows as unknown as { id: string }[];
  return Number(row!.id);
}

export interface AuditArgs {
  mint: string;
  symbol: string | null;
  wallets: string[];
  firstBuyAtMs: number;
  sharedFunder: string | null;
}

// Record a co-funded confluence as a CLOSED audit row. Never tracked, never
// scored — it documents what a naive tracker would have called and we did not.
export async function recordCoFundedAudit(db: DbClient, a: AuditArgs): Promise<void> {
  const walletsJson = JSON.stringify(a.wallets);
  const firstBuyIso = new Date(a.firstBuyAtMs).toISOString();
  await db.execute(sql`
    INSERT INTO signals
      (mint, symbol, wallet_count, wallets, trust, shared_funder, first_buy_at, status)
    VALUES (
      ${a.mint}, ${a.symbol}, ${a.wallets.length}, ${walletsJson}::jsonb, 'co_funded',
      ${a.sharedFunder}, ${firstBuyIso}, 'closed'
    )
  `);
}

// Recompute signal_signals / signal_wins / signal_winrate for the given
// wallets from CLOSED independent signals. Called when a signal closes.
export async function recomputeWalletAttribution(db: DbClient, wallets: string[]): Promise<void> {
  if (wallets.length === 0) return;
  const walletsJson = JSON.stringify(wallets);
  await db.execute(sql`
    WITH targets AS (
      SELECT jsonb_array_elements_text(${walletsJson}::jsonb) AS address
    ),
    stats AS (
      SELECT w.address,
             count(*) FILTER (WHERE s.id IS NOT NULL) AS signals,
             count(*) FILTER (WHERE s.is_hit) AS wins
      FROM targets w
      LEFT JOIN signals s
        ON s.trust = 'independent'
       AND s.status = 'closed'
       AND s.wallets ? w.address
      GROUP BY w.address
    )
    UPDATE tracked_wallets tw
    SET signal_signals = stats.signals,
        signal_wins = stats.wins,
        signal_winrate = CASE WHEN stats.signals > 0
                              THEN round(stats.wins::numeric / stats.signals, 4)
                              ELSE NULL END
    FROM stats
    WHERE tw.address = stats.address
  `);
}
