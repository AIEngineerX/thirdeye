// Response shapes for the Solana Tracker Data API endpoints ThirdEye consumes.
// Typed against live responses captured 2026-05-24. Only the fields the wallet
// PnL view reads are modeled; the API returns more, but we don't depend on it.
//
// The API returns explicit `null` (not absent) for empty values — identity,
// roi, timing fields — so those are `T | null`, not optional.

export interface PnlAmounts {
  realized: number;
  unrealized: number;
  total: number;
}

export interface WalletPnlSummary {
  wallet: string;
  /** "strict" filters out gamed/wash PnL; the field tells us which mode produced these numbers. */
  pnlMode: string;
  identity: string | null;
  summary: {
    pnl: PnlAmounts;
    invested: number;
    proceeds: number;
    openPositions: { cost: number; value: number };
    counts: {
      buys: number;
      sells: number;
      trades: number;
      tokensTraded: number;
      tokensHeldEver: number;
    };
    averages: { buy: number; sell: number };
    roi: number;
    timing: { firstTrade: number | null; lastTrade: number | null };
  };
  analysis: {
    winRate: number;
    avgPnlPerAsset: number;
    avgBuyValue: number;
    tokens: { closed: number; winning: number; losing: number };
    distribution: Array<{ range: string; count: number; rate: number }>;
  };
}

export interface TokenPosition {
  token: string;
  pnl: PnlAmounts & { realizedRaw: number };
  invested: number;
  proceeds: number;
  roi: number | null;
  current: {
    balance: number;
    costBasis: number;
    value: number;
    price: number;
    avgCost: number;
  };
  volume: { tokensBought: number; tokensSold: number; buyUsd: number; sellUsd: number };
  counts: { buys: number; sells: number; total: number };
  timing: {
    firstBuy: number | null;
    lastBuy: number | null;
    firstSell: number | null;
    lastSell: number | null;
    firstTrade: number | null;
    lastTrade: number | null;
    holdTimeSecs: number | null;
  };
  meta: {
    symbol: string;
    name: string;
    image: string | null;
    decimals: number;
    price: number;
    marketCap: number;
    liquidity: number;
    primaryMarket: string | null;
    rugged: boolean;
  };
  portfolioPercent: number | null;
}

export interface WalletPositions {
  wallet: string;
  identity: string | null;
  positions: TokenPosition[];
}

export interface WalletPerformanceDay {
  date: string;
  realizedPnl: number;
  volume: number;
  totalPnl: number;
  trades: number;
}

export interface WalletPerformance {
  wallet: string;
  identity: string | null;
  /** Number of days the window covers (e.g. 30). */
  window: number;
  totals: { realizedPnl: number; volume: number; trades: number };
  bestDay: WalletPerformanceDay;
  worstDay: WalletPerformanceDay;
  streaks: { positive: number; negative: number; currentPositive: number; currentNegative: number };
  drawdown: { amount: number; percent: number };
  days: WalletPerformanceDay[];
}

export interface TradeSide {
  address: string;
  amount: number;
  token: { name: string; symbol: string; image: string | null; decimals: number };
  priceUsd: number;
  marketCap: number;
}

export interface WalletTrade {
  tx: string;
  from: TradeSide;
  to: TradeSide;
  price: { usd: number; sol: number };
  volume: { usd: number; sol: number };
  wallet: string;
  /** DEX/program the swap routed through (e.g. "pumpfun-amm"). */
  program: string;
  /** Epoch milliseconds. */
  time: number;
}

export interface WalletTrades {
  trades: WalletTrade[];
  nextCursor: string | null;
  hasNextPage: boolean;
}
