import type { TokenVerdict } from "./types";

export interface RiskInputs {
  totalClusteredPct: number;
  sybilFlag: boolean;
  maxClusterPct: number;
  freshFunderCount: number;
  totalClusters: number;
}

export function computeRisk(inputs: RiskInputs): number {
  const sybilBonus = inputs.sybilFlag ? 25 : 0;
  const maxClusterBonus = inputs.maxClusterPct > 5 ? 15 : 0;
  const freshFunderRatio = inputs.freshFunderCount / Math.max(inputs.totalClusters, 1);
  const raw = inputs.totalClusteredPct + sybilBonus + maxClusterBonus + freshFunderRatio * 10;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function tokenVerdict(risk: number): TokenVerdict {
  if (risk <= 10) return "CLEAN";
  if (risk <= 35) return "LOW_RISK";
  return "HIGH_RISK";
}
