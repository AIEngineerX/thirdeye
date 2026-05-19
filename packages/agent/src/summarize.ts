import type {
  ScoreBucket,
  Tag,
  TokenScanResult,
  TokenVerdict,
  Verdict,
  WalletCheckResult,
} from "@thirdeye/scanner";

export interface WalletSummary {
  address: string;
  ageDays: number;
  txCount: number;
  usdValue: number;
  tokenCount: number;
  tags: Tag[];
  score: number;
  scoreBucket: ScoreBucket;
  verdict: Verdict;
  realizedPnlSol: number | null;
  cluster: {
    firstFunder: string | null;
    size: number;
    cov: number | null;
    timeWindowSiblingCount: number;
  };
  funding: {
    hops: number;
    rootIsExchange: boolean;
  };
  // Phase 6b ships topActivity as []. The current TxPattern doesn't carry
  // per-tx detail (only counts/aggregates); 6c can extend the scanner to
  // emit a top-5 slice when discovery wants it. The shape is stable so
  // future additions don't break consumers.
  topActivity: Array<{ kind: string; mint?: string; solDelta?: number }>;
}

export function summarizeWalletForLLM(r: WalletCheckResult): WalletSummary {
  // The funding chain is ordered from the wallet itself (depth=0) outward;
  // the deepest hop (last entry) is the funding origin — that's what
  // "root" means in the spec's rootIsExchange.
  const root = r.funding.chain.at(-1);
  return {
    address: r.address,
    ageDays: r.txPattern.ageDays,
    txCount: r.txPattern.txCount,
    usdValue: r.balances.usdValue,
    tokenCount: r.balances.tokenCount,
    tags: r.tags,
    score: r.score,
    scoreBucket: r.scoreBucket,
    verdict: r.verdict,
    realizedPnlSol: r.realizedPnlSol,
    cluster: {
      firstFunder: r.cluster.firstFunder,
      size: r.cluster.size,
      cov: r.cluster.cov,
      timeWindowSiblingCount: r.cluster.timeWindowSiblings.length,
    },
    funding: {
      hops: r.funding.chain.length,
      rootIsExchange: root?.isExchange ?? false,
    },
    topActivity: [],
  };
}

// M7: scanToken returned a full TokenScanResult to the LLM — including the
// raw top-holder list (200+ rows on shared mode, 500+ on BYOK) plus full
// per-cluster member lists. On a high-holder mint the JSON payload was
// hundreds of KB, which (a) became the dominant cost contributor on any
// run that called scanToken and (b) was an adversarial-prompt budget-
// exhaustion vector.
//
// summarizeTokenScanForLLM projects to a compact shape: just the headline
// counts, top-5 holders, and per-cluster summaries (member counts, not
// full member lists). Adversarial input can no longer balloon the LLM
// context proportional to the token's holder count.
export interface TokenScanSummary {
  mint: string;
  name: string | null;
  symbol: string | null;
  totalHolders: number;
  scannedHolders: number;
  topHolders: Array<{ owner: string; pct: number }>;
  lp: { totalPct: number };
  locked: { totalPct: number };
  clusters: Array<{
    root: string;
    memberCount: number;
    totalPct: number;
    isFreshFunder: boolean;
    priorTagSummary: Record<string, number>;
  }>;
  totalClusteredPct: number;
  maxClusterPct: number;
  freshFunderCount: number;
  risk: number;
  sybilFlag: boolean;
  verdict: TokenVerdict;
  scannedAt: string;
}

const SUMMARY_TOP_HOLDERS = 5;
const SUMMARY_MAX_CLUSTERS = 10;

export function summarizeTokenScanForLLM(r: TokenScanResult): TokenScanSummary {
  const topHolders = r.topHolders.slice(0, SUMMARY_TOP_HOLDERS).map((h) => ({
    owner: h.owner,
    pct: h.pct,
  }));

  // Project each cluster to (root, memberCount, totalPct, isFreshFunder,
  // priorTagSummary) — drop the full member list and the per-member tag
  // arrays. priorTagSummary maps a tag name to the count of members
  // carrying it so the LLM can still reason about "5/10 BUNDLERs" without
  // every member address.
  const clusters = r.clusters.slice(0, SUMMARY_MAX_CLUSTERS).map((c) => {
    const tagCounts: Record<string, number> = {};
    for (const tags of Object.values(c.priorTags)) {
      for (const t of tags) {
        tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      }
    }
    return {
      root: c.root,
      memberCount: c.members.length,
      totalPct: c.totalPct,
      isFreshFunder: c.isFreshFunder,
      priorTagSummary: tagCounts,
    };
  });

  return {
    mint: r.mint,
    name: r.metadata.name,
    symbol: r.metadata.symbol,
    totalHolders: r.totalHolders,
    scannedHolders: r.scannedHolders,
    topHolders,
    lp: { totalPct: r.lp.totalPct },
    locked: { totalPct: r.locked.totalPct },
    clusters,
    totalClusteredPct: r.totalClusteredPct,
    maxClusterPct: r.maxClusterPct,
    freshFunderCount: r.freshFunderCount,
    risk: r.risk,
    sybilFlag: r.sybilFlag,
    verdict: r.verdict,
    scannedAt: r.scannedAt,
  };
}
