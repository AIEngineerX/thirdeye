import type { Cluster, Identity, SiblingWallet } from "./types";

const TIME_WINDOW_MS = 5 * 60 * 1000;

export interface ClusterInputs {
  targetAddress: string;
  targetFundedAt: string | null;
  firstFunder: string | null;
  rawSiblings: { address: string; fundedAt: string | null }[];
  identitiesByAddress: Map<string, Identity>;
  // CoV of cluster tx amounts. v1 always passes null — populating requires
  // per-sibling tx fetch (~50× the credit cost). v1.1 enhancement.
  cov?: number | null;
}

export function buildCluster(inputs: ClusterInputs): Cluster {
  const siblings: SiblingWallet[] = inputs.rawSiblings
    .filter((s) => s.address !== inputs.targetAddress)
    .map((s) => ({
      address: s.address,
      fundedAt: s.fundedAt,
      identity: inputs.identitiesByAddress.get(s.address) ?? null,
    }));

  const targetTime = inputs.targetFundedAt ? Date.parse(inputs.targetFundedAt) : null;
  const timeWindowSiblings =
    targetTime === null
      ? []
      : siblings
          .filter(
            (s) =>
              s.fundedAt !== null &&
              Math.abs(Date.parse(s.fundedAt) - targetTime) <= TIME_WINDOW_MS,
          )
          .map((s) => s.address);

  return {
    firstFunder: inputs.firstFunder,
    size: siblings.length + 1,
    siblings,
    timeWindowSiblings,
    cov: inputs.cov ?? null,
  };
}

// Returns null if fewer than 3 wallets have ≥ 5 tx samples — insufficient
// for a stable signal.
export function computeCov(amountsByWallet: Map<string, number[]>): number | null {
  const meansPerWallet: number[] = [];
  for (const amounts of amountsByWallet.values()) {
    if (amounts.length < 5) continue;
    const sum = amounts.reduce((a, b) => a + b, 0);
    meansPerWallet.push(sum / amounts.length);
  }
  if (meansPerWallet.length < 3) return null;

  const mean = meansPerWallet.reduce((a, b) => a + b, 0) / meansPerWallet.length;
  if (mean === 0) return null;
  const variance =
    meansPerWallet.reduce((acc, v) => acc + (v - mean) ** 2, 0) / meansPerWallet.length;
  const stdDev = Math.sqrt(variance);
  return stdDev / mean;
}
