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
  // Phase 5d: net SOL realized across the last 30d of SWAPs.
  // Positive ⇒ wallet has been net-extracting SOL from swaps.
  // Null ⇒ no swap activity in window or fetch failed.
  realizedPnlSol: number | null;
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

// ── Scan Token ──────────────────────────────────────────────────────────────

export type TokenVerdict = "CLEAN" | "LOW_RISK" | "HIGH_RISK";

export interface TokenMetadata {
  mint: string;
  name: string | null;
  symbol: string | null;
  supply: string; // raw u64 string (apply decimals client-side)
  decimals: number;
  updateAuthority: string | null;
  firstCreator: string | null;
}

export interface TokenHolderAccount {
  address: string; // token account
  owner: string; // wallet that owns the token account
  amount: string; // raw u64 string
}

export interface TopHolder {
  owner: string;
  amount: string;
  pct: number; // 0-100, of supply
}

export interface LpHolder {
  owner: string;
  pct: number;
  category: "lp" | "locked";
}

export interface TokenCluster {
  root: string; // first funder address
  members: string[]; // owner addresses (subset of TopHolder.owner)
  totalPct: number; // sum of supply pct across members
  isFreshFunder: boolean;
  priorTags: Record<string, string[]>; // member → known tags from `wallets` table
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
  risk: number; // 0-100
  sybilFlag: boolean;
  verdict: TokenVerdict;
  scannedAt: string; // ISO8601
}

export type ScanTokenEvent =
  | { event: "started"; data: { mint: string; mode: ScanMode; cached: boolean } }
  | { event: "metadata"; data: TokenMetadata & { launchpad: string | null } }
  | {
      event: "holders";
      data: { totalHolders: number; scannedHolders: number; top: TopHolder[] };
    }
  | {
      event: "lpFilter";
      data: {
        lpPct: number;
        lockedPct: number;
        lpHolders: LpHolder[];
        lockedHolders: LpHolder[];
      };
    }
  | {
      event: "fundingProgress";
      data: { scanned: number; total: number; errored: number };
    }
  | { event: "clusters"; data: { clusters: TokenCluster[] } }
  | { event: "result"; data: TokenScanResult }
  | { event: "error"; data: { error: string; message: string } };
