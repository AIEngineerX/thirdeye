/**
 * Type shapes the dashboard consumes from the api. Mirrors the source of
 * truth at `packages/scanner/src/types.ts` — kept local to apps/web so the
 * scanner package's runtime never lands in the browser bundle. Updates
 * happen in lockstep when the api changes (a UI render error is the signal).
 */

export type Tag =
  | "FRESH_WALLET"
  | "FUND_DISTRIBUTOR"
  | "BUNDLER"
  | "BUNDLER_TIGHT"
  | "SYBIL"
  | "SNIPER"
  | "WHALE"
  | "SMART_MONEY"
  | "EXCHANGE"
  | "KOL";

export type Verdict =
  | "EXCHANGE"
  | "SYBIL"
  | "BUNDLER"
  | "SNIPER BOT"
  | "SMART_MONEY"
  | "WHALE"
  | "FRESH"
  | "TRADER"
  | "CLEAN";

export type ScoreBucket = "CLEAN" | "LOW" | "MEDIUM" | "HIGH";
export type TokenVerdict = "CLEAN" | "LOW_RISK" | "HIGH_RISK";
export type ScanMode = "shared" | "byok";

export interface Identity {
  address: string;
  name: string | null;
  type: string | null;
  category: string | null;
}

export interface TokenBalance {
  mint: string;
  amount: string;
  decimals: number;
  symbol: string | null;
  name: string | null;
  usdValue: number | null;
}

export interface Balances {
  solBalance: number;
  usdValue: number;
  tokenCount: number;
  tokens: TokenBalance[];
}

export interface FundingHop {
  depth: number;
  address: string;
  funder: string | null;
  fundedAt: string | null;
  signature: string | null;
  isExchange: boolean;
  isLaunchpad: boolean;
}

export interface SiblingWallet {
  address: string;
  fundedAt: string | null;
  identity: Identity | null;
}

export interface Cluster {
  firstFunder: string | null;
  size: number;
  siblings: SiblingWallet[];
  timeWindowSiblings: string[];
  cov: number | null;
}

export interface TxPattern {
  txCount: number;
  ageDays: number;
  avgGapSec: number | null;
  swapOnly: boolean;
  rapidFire: boolean;
  uniqueOutboundRecipients: number;
}

export interface WalletCheckResult {
  address: string;
  mode: ScanMode;
  identity: Identity;
  balances: Balances;
  funding: { chain: FundingHop[] };
  cluster: Cluster;
  txPattern: TxPattern;
  tags: Tag[];
  realizedPnlSol: number | null;
  score: number;
  scoreBucket: ScoreBucket;
  verdict: Verdict;
  scannedAt: string;
}

export interface TokenMetadata {
  mint: string;
  name: string | null;
  symbol: string | null;
  supply: string;
  decimals: number;
  updateAuthority: string | null;
  firstCreator: string | null;
}

export interface TopHolder {
  owner: string;
  amount: string;
  pct: number;
}

export interface LpHolder {
  owner: string;
  pct: number;
  category: "lp" | "locked";
}

export interface TokenCluster {
  root: string;
  members: string[];
  totalPct: number;
  isFreshFunder: boolean;
  priorTags: Record<string, string[]>;
}

export interface TokenScanResult {
  mint: string;
  mode: ScanMode;
  metadata: TokenMetadata;
  totalHolders: number;
  scannedHolders: number;
  topHolders: TopHolder[];
  lp: { totalPct: number; holders: LpHolder[] };
  locked: { totalPct: number; holders: LpHolder[] };
  clusters: TokenCluster[];
  totalClusteredPct: number;
  maxClusterPct: number;
  freshFunderCount: number;
  risk: number;
  sybilFlag: boolean;
  verdict: TokenVerdict;
  scannedAt: string;
}

/** Dashboard bundle returned by `GET /api/db/dashboard`. */
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

/** Intel-bus events delivered over `/api/db/intel/feed`. */
export type IntelEvent =
  | { event: "scan:start"; data: { mint: string; symbol: string | null } }
  | {
      event: "scan:complete";
      data: {
        id: number | null;
        mint: string;
        symbol: string | null;
        risk: number;
        sybilFlag: boolean;
      };
    }
  | { event: "check:start"; data: { address: string } }
  | {
      event: "check:complete";
      data: { address: string; score: number; verdict: string };
    }
  | { event: "tag:applied"; data: { address: string; tag: string } }
  | { event: "watch:event"; data: { address: string; signature: string; type: string } }
  | { event: "hello"; data: { at: string } }
  | { event: "ping"; data: Record<string, never> };
