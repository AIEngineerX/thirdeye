/**
 * Wallet PnL response shapes — mirror of GET /api/wallet/:addr/pnl, which
 * proxies Solana Tracker. Defined here (not imported from @thirdeye/
 * solanatracker) because apps/web compiles with `types: []` + no workspace
 * package resolution; the browser only needs the fields it renders.
 */

export interface WalletPnlSummary {
  wallet: string;
  /** "strict" means the figures already exclude wash/manipulated trades. */
  pnlMode: string;
  summary: {
    pnl: { realized: number; unrealized: number; total: number };
    invested: number;
    proceeds: number;
    counts: { buys: number; sells: number; trades: number; tokensTraded: number };
    roi: number;
  };
  analysis: {
    winRate: number;
    tokens: { closed: number; winning: number; losing: number };
  };
}

export interface TokenPosition {
  token: string;
  pnl: { realized: number; unrealized: number; total: number };
  invested: number;
  roi: number | null;
  current: { balance: number; value: number };
  meta: { symbol: string; name: string; rugged: boolean };
}

export interface WalletTrade {
  tx: string;
  from: { address: string; token: { symbol: string } };
  to: { address: string; token: { symbol: string } };
  volume: { usd: number; sol: number };
  program: string;
  time: number;
}

export interface WalletPnlResponse {
  summary: WalletPnlSummary;
  positions: TokenPosition[];
  trades: WalletTrade[];
  hasMoreTrades: boolean;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
