// JSON-RPC method allowlist for the /api/helius-rpc pass-through.
//
// The product is read-only by design (CLAUDE.md). We switched from a denylist
// to an allowlist so newly-added Solana RPC methods (e.g. a future mutating
// method) can't slip through by default. Notable additions over the prior
// deny list: sendRawTransaction (the canonical signed-tx submission method,
// previously missing from the deny list) is now blocked by virtue of not
// being on the allow list.
//
// Includes:
//   - Standard Solana read methods (https://solana.com/docs/rpc)
//   - DAS / Helius getter extensions (cNFT proofs, asset search, etc.)
// Excludes:
//   - All mutating methods (sendTransaction, sendRawTransaction,
//     requestAirdrop, simulateTransaction)
//   - Subscription methods (proxy is HTTP-only; clients use Helius LaserStream
//     for websockets)
export const RPC_ALLOW_LIST: ReadonlySet<string> = new Set([
  // ---- Standard Solana read RPC ----
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockCommitment",
  "getBlockHeight",
  "getBlockProduction",
  "getBlockTime",
  "getBlocks",
  "getBlocksWithLimit",
  "getClusterNodes",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getHighestSnapshotSlot",
  "getIdentity",
  "getInflationGovernor",
  "getInflationRate",
  "getInflationReward",
  "getLargestAccounts",
  "getLatestBlockhash",
  "getLeaderSchedule",
  "getMaxRetransmitSlot",
  "getMaxShredInsertSlot",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPerformanceSamples",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getSlotLeader",
  "getSlotLeaders",
  "getStakeMinimumDelegation",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
  "minimumLedgerSlot",
  // ---- Helius DAS (Digital Asset Standard) read extensions ----
  "getAsset",
  "getAssetBatch",
  "getAssetProof",
  "getAssetProofBatch",
  "getAssetsByOwner",
  "getAssetsByGroup",
  "getAssetsByCreator",
  "getAssetsByAuthority",
  "searchAssets",
  "getSignaturesForAsset",
  "getNftEditions",
  "getTokenAccounts",
  // ---- Helius enhanced RPC ----
  "getPriorityFeeEstimate",
]);

export type RpcEnvelopeResult =
  | { kind: "ok"; method: string; params: unknown[] }
  | { kind: "invalid"; reason: string }
  | { kind: "forbidden"; method: string };

export function validateRpcEnvelope(input: unknown): RpcEnvelopeResult {
  if (input === null || typeof input !== "object") {
    return { kind: "invalid", reason: "body must be a JSON object" };
  }
  // Reject batched RPC explicitly. Helius's behavior on JSON-array bodies is
  // undocumented and we have no use case that needs batching at this layer.
  if (Array.isArray(input)) {
    return { kind: "invalid", reason: "batched RPC (array body) is not supported" };
  }
  const e = input as Record<string, unknown>;
  if (e.jsonrpc !== "2.0") {
    return { kind: "invalid", reason: "jsonrpc must be '2.0'" };
  }
  if (typeof e.method !== "string" || e.method.length === 0) {
    return { kind: "invalid", reason: "method must be a non-empty string" };
  }
  if (!Array.isArray(e.params)) {
    return { kind: "invalid", reason: "params must be an array" };
  }
  if (!RPC_ALLOW_LIST.has(e.method)) {
    return { kind: "forbidden", method: e.method };
  }
  return { kind: "ok", method: e.method, params: e.params };
}
