import type { ScoreBucket, Tag, Verdict, WalletCheckResult } from "@thirdeye/scanner";

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
