import { buildCluster } from "./cluster";
import { computeClusterCov } from "./cluster-cov";
import { traceFundingChain } from "./funding-chain";
import { HeliusClient } from "./helius-client";
import { computeRealizedSolPnl } from "./pnl";
import { computeScore, scoreBucket } from "./score";
import { computeTags } from "./tags";
import { analyzeTxPattern } from "./tx-patterns";
import type { CheckEvent, Cluster, ScanMode, WalletCheckResult } from "./types";
import { computeVerdict } from "./verdict";

// Phase 5a: BYOK cluster limit 200 → 300 to capture larger bundler ops.
// Shared mode unchanged (50) to bound credit cost for free / low-tier users.
const SHARED_MAX_HOPS = 3;
const BYOK_MAX_HOPS = 5;
const SHARED_CLUSTER_LIMIT = 50;
const BYOK_CLUSTER_LIMIT = 300;

export interface CheckWalletOptions {
  address: string;
  serverKey: string | undefined;
  userKey?: string | undefined;
  // Sibling resolver — usually a DB query against `wallets` keyed on `first_funder`.
  resolveSiblings: (
    firstFunder: string,
    limit: number,
  ) => Promise<{ address: string; fundedAt: string | null }[]>;
  // Phase 5d: SOL threshold above which SMART_MONEY tag fires. Passed in
  // from the route handler so the scanner package stays env-agnostic.
  smartMoneyMinSol: number;
}

export async function* checkWallet(opts: CheckWalletOptions): AsyncGenerator<CheckEvent> {
  const mode: ScanMode = opts.userKey ? "byok" : "shared";
  const maxHops = mode === "byok" ? BYOK_MAX_HOPS : SHARED_MAX_HOPS;
  const clusterLimit = mode === "byok" ? BYOK_CLUSTER_LIMIT : SHARED_CLUSTER_LIMIT;

  yield { event: "started", data: { addr: opts.address, mode, cached: false } };

  const client = new HeliusClient({
    serverKey: opts.serverKey,
    ...(opts.userKey !== undefined && { userKey: opts.userKey }),
  });

  const identity = await client.identity(opts.address);
  yield { event: "identity", data: identity };

  const balances = await client.balances(opts.address);
  yield { event: "balances", data: balances };

  const chain = await traceFundingChain({
    startAddress: opts.address,
    maxHops,
    resolveFundedBy: (a) => client.fundedBy(a),
  });
  yield { event: "funding", data: { chain } };

  const targetFunder = chain[0]?.funder ?? null;
  const targetFundedAt = chain[0]?.fundedAt ?? null;

  let cluster: Cluster = {
    firstFunder: targetFunder,
    size: 1,
    siblings: [],
    timeWindowSiblings: [],
    cov: null,
  };

  if (targetFunder !== null) {
    const rawSiblings = await opts.resolveSiblings(targetFunder, clusterLimit);
    const identitiesByAddress = await client.batchIdentity(rawSiblings.map((s) => s.address));
    cluster = buildCluster({
      targetAddress: opts.address,
      targetFundedAt,
      firstFunder: targetFunder,
      rawSiblings,
      identitiesByAddress,
    });

    // Phase 5b: compute CoV across cluster siblings' SOL outflows. Lights
    // up the SYBIL tag (was hardcoded null in v1). Sample-bounded; per-
    // member errors swallowed so one bad sibling can't kill the signal.
    const memberAddrs = cluster.siblings.map((s) => s.address);
    const cov = await computeClusterCov(client, memberAddrs, opts.address);
    cluster = { ...cluster, cov };
  }
  yield { event: "cluster", data: cluster };

  const txs = await client.transactions(opts.address, 100);
  const txPattern = analyzeTxPattern(opts.address, txs);
  yield { event: "txPattern", data: txPattern };

  // Phase 5d: realized SOL PnL across SWAPs in the 30d window. Reuses
  // the txs array we already fetched — zero extra Helius cost.
  const realizedPnlSol = txs.length > 0 ? computeRealizedSolPnl(opts.address, txs) : null;

  const tags = computeTags({
    identity,
    ageDays: txPattern.ageDays,
    txCount: txPattern.txCount,
    usdValue: balances.usdValue,
    tokenCount: balances.tokenCount,
    cluster,
    txPattern,
    realizedPnlSol,
    smartMoneyMinSol: opts.smartMoneyMinSol,
  });
  yield { event: "tags", data: { tags } };

  const score = computeScore({ tags, clusterSize: cluster.size });
  const verdict = computeVerdict({ tags, txCount: txPattern.txCount });

  const result: WalletCheckResult = {
    address: opts.address,
    mode,
    identity,
    balances,
    funding: { chain },
    cluster,
    txPattern,
    tags,
    realizedPnlSol,
    score,
    scoreBucket: scoreBucket(score),
    verdict,
    scannedAt: new Date().toISOString(),
  };
  yield { event: "result", data: result };
}
