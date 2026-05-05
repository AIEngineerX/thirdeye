export type Tag =
  | "FRESH_WALLET"
  | "FUND_DISTRIBUTOR"
  | "BUNDLER"
  | "BUNDLER_TIGHT"
  | "SYBIL"
  | "SNIPER"
  | "WHALE"
  | "EXCHANGE"
  | "KOL";

export type Verdict =
  | "EXCHANGE"
  | "SYBIL"
  | "BUNDLER"
  | "SNIPER BOT"
  | "WHALE"
  | "FRESH"
  | "TRADER"
  | "CLEAN";

export type ScoreBucket = "CLEAN" | "LOW" | "MEDIUM" | "HIGH";
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
  fundedAt: string | null; // ISO8601
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
  timeWindowSiblings: string[]; // addresses funded within 5 min of target
  cov: number | null; // coefficient of variation of cluster tx amounts; null if too sparse
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
  score: number;
  scoreBucket: ScoreBucket;
  verdict: Verdict;
  scannedAt: string; // ISO8601
}

// SSE events emitted by checkWallet().
export type CheckEvent =
  | { event: "started"; data: { addr: string; mode: ScanMode; cached: boolean } }
  | { event: "identity"; data: Identity }
  | { event: "balances"; data: Balances }
  | { event: "funding"; data: { chain: FundingHop[] } }
  | { event: "cluster"; data: Cluster }
  | { event: "txPattern"; data: TxPattern }
  | { event: "tags"; data: { tags: Tag[] } }
  | { event: "result"; data: WalletCheckResult }
  | { event: "error"; data: { error: string; message: string } };
