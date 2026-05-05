import { buildCluster } from "./cluster";
import { firstFunder, fundedAt, traceFundingChain } from "./funding-chain";
import { HeliusClient } from "./helius-client";
import { computeScore, scoreBucket } from "./score";
import { computeTags } from "./tags";
import { analyzeTxPattern } from "./tx-patterns";
import type { CheckEvent, ScanMode, WalletCheckResult } from "./types";
import { computeVerdict } from "./verdict";

const SHARED_MAX_HOPS = 3;
const BYOK_MAX_HOPS = 5;
const SHARED_CLUSTER_LIMIT = 50;
const BYOK_CLUSTER_LIMIT = 200;

export interface CheckWalletOptions {
  address: string;
  serverKey: string | undefined;
  userKey?: string | undefined;
  // Sibling resolver — usually a DB query against `wallets` keyed on `first_funder`.
  resolveSiblings: (
    firstFunder: string,
    limit: number,
  ) => Promise<{ address: string; fundedAt: string | null }[]>;
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

  const targetFunder = firstFunder(chain);
  const targetFundedAt = fundedAt(chain);

  let cluster = {
    firstFunder: targetFunder,
    size: 1,
    siblings: [],
    timeWindowSiblings: [],
    cov: null,
  } as Awaited<ReturnType<typeof buildCluster>>;

  if (targetFunder !== null) {
    const rawSiblings = await opts.resolveSiblings(targetFunder, clusterLimit);
    const identitiesByAddress = await client.batchIdentity(rawSiblings.map((s) => s.address));
    cluster = buildCluster({
      targetAddress: opts.address,
      targetFundedAt,
      firstFunder: targetFunder,
      rawSiblings,
      identitiesByAddress,
      clusterTxAmounts: new Map(), // CoV computation upgraded in v1.1 (requires per-sibling tx fetch — out of Phase 2 scope)
    });
  }
  yield { event: "cluster", data: cluster };

  const txs = await client.transactions(opts.address, 100);
  const txPattern = analyzeTxPattern(opts.address, txs);
  yield { event: "txPattern", data: txPattern };

  const tags = computeTags({
    identity,
    ageDays: txPattern.ageDays,
    txCount: txPattern.txCount,
    usdValue: balances.usdValue,
    tokenCount: balances.tokenCount,
    cluster,
    txPattern,
    firstFunder: targetFunder,
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
    score,
    scoreBucket: scoreBucket(score),
    verdict,
    scannedAt: new Date().toISOString(),
  };
  yield { event: "result", data: result };
}
