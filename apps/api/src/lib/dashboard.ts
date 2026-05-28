import type { DbClient } from "@thirdeye/db";
import { sql } from "drizzle-orm";

export interface DashboardStats {
  total_signals: number;
  hits: number;
  hit_rate: number;
  avg_multiplier: number | null;
  best_multiplier: number | null;
  best_multiplier_symbol: string | null;
  open_signals: number;
}
export interface DashboardSignal {
  id: number;
  mint: string;
  symbol: string | null;
  wallet_count: number;
  trust: string;
  call_mc: number | null;
  current_mc: number | null;
  ath_multiplier: number | null;
  safe_ath_multiplier: number | null;
  is_hit: boolean;
  status: string;
  detected_at: string;
}
export interface DashboardTrending {
  mint: string;
  symbol: string | null;
  name: string | null;
  mc_usd: number | null;
  price_usd: number | null;
  mc_24h_pct: number | null;
  liquidity_usd: number | null;
}
export interface DashboardTrader {
  address: string;
  label: string | null;
  signal_wins: number;
  signal_signals: number;
  signal_winrate: number | null;
  realized_pnl_usd: number | null;
  win_rate: number | null;
}
export interface DashboardBundle {
  generated_at: string;
  stats: DashboardStats;
  live_signals: DashboardSignal[];
  trending: DashboardTrending[];
  top_traders: DashboardTrader[];
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function buildDashboard(db: DbClient): Promise<DashboardBundle> {
  const statsRows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE trust='independent') AS total_signals,
      count(*) FILTER (WHERE trust='independent' AND is_hit) AS hits,
      count(*) FILTER (WHERE trust='independent' AND status='open') AS open_signals,
      avg(ath_multiplier) FILTER (WHERE trust='independent' AND ath_multiplier IS NOT NULL) AS avg_multiplier,
      max(ath_multiplier) FILTER (WHERE trust='independent') AS best_multiplier
    FROM signals
  `)) as unknown as Array<Record<string, unknown>>;
  const s = statsRows[0] ?? {};
  const total = Number(s.total_signals ?? 0);
  const hits = Number(s.hits ?? 0);
  const best = n(s.best_multiplier);
  let bestSym: string | null = null;
  if (best !== null) {
    const br = (await db.execute(sql`
      SELECT symbol FROM signals WHERE trust='independent' AND ath_multiplier = ${best} LIMIT 1
    `)) as unknown as Array<{ symbol: string | null }>;
    bestSym = br[0]?.symbol ?? null;
  }

  const sigRows = (await db.execute(sql`
    SELECT id, mint, symbol, wallet_count, trust, call_mc, current_mc,
           ath_multiplier, safe_ath_multiplier, is_hit, status, detected_at
    FROM signals WHERE trust='independent'
    ORDER BY detected_at DESC LIMIT 25
  `)) as unknown as Array<Record<string, unknown>>;

  const trendRows = (await db.execute(sql`
    SELECT mint, symbol, name, mc_usd, price_usd, mc_24h_pct, liquidity_usd
    FROM tokens
    WHERE mc_24h_pct IS NOT NULL AND last_refreshed_at > now() - interval '24 hours'
    ORDER BY mc_24h_pct DESC NULLS LAST LIMIT 10
  `)) as unknown as Array<Record<string, unknown>>;

  const traderRows = (await db.execute(sql`
    SELECT address, label, signal_wins, signal_signals, signal_winrate, realized_pnl_usd, win_rate
    FROM tracked_wallets
    ORDER BY signal_winrate DESC NULLS LAST, signal_wins DESC LIMIT 10
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    generated_at: new Date().toISOString(),
    stats: {
      total_signals: total,
      hits,
      hit_rate: total > 0 ? hits / total : 0,
      avg_multiplier: n(s.avg_multiplier),
      best_multiplier: best,
      best_multiplier_symbol: bestSym,
      open_signals: Number(s.open_signals ?? 0),
    },
    live_signals: sigRows.map((r) => ({
      id: Number(r.id),
      mint: r.mint as string,
      symbol: (r.symbol as string) ?? null,
      wallet_count: Number(r.wallet_count),
      trust: r.trust as string,
      call_mc: n(r.call_mc),
      current_mc: n(r.current_mc),
      ath_multiplier: n(r.ath_multiplier),
      safe_ath_multiplier: n(r.safe_ath_multiplier),
      is_hit: r.is_hit === true,
      status: r.status as string,
      detected_at: new Date(r.detected_at as string).toISOString(),
    })),
    trending: trendRows.map((r) => ({
      mint: r.mint as string,
      symbol: (r.symbol as string) ?? null,
      name: (r.name as string) ?? null,
      mc_usd: n(r.mc_usd),
      price_usd: n(r.price_usd),
      mc_24h_pct: n(r.mc_24h_pct),
      liquidity_usd: n(r.liquidity_usd),
    })),
    top_traders: traderRows.map((r) => ({
      address: r.address as string,
      label: (r.label as string) ?? null,
      signal_wins: Number(r.signal_wins ?? 0),
      signal_signals: Number(r.signal_signals ?? 0),
      signal_winrate: n(r.signal_winrate),
      realized_pnl_usd: n(r.realized_pnl_usd),
      win_rate: n(r.win_rate),
    })),
  };
}
