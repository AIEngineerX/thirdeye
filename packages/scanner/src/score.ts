import type { ScoreBucket, Tag } from "./types";

export interface ScoreInputs {
  tags: Tag[];
  clusterSize: number;
}

export function computeScore(inputs: ScoreInputs): number {
  const has = (t: Tag): boolean => inputs.tags.includes(t);
  let score = 0;
  if (has("FRESH_WALLET")) score += 10;
  if (has("FUND_DISTRIBUTOR")) score += 20;
  if (has("BUNDLER")) score += 30;
  if (has("BUNDLER_TIGHT")) score += 10;
  if (has("SYBIL")) score += 25;
  if (has("SNIPER")) score += 15;
  if (has("EXCHANGE")) score -= 50;
  if (has("KOL")) score -= 10;
  if (has("SMART_MONEY")) score -= 15;
  score += Math.min(inputs.clusterSize, 50) * 0.5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreBucket(score: number): ScoreBucket {
  if (score <= 20) return "CLEAN";
  if (score <= 45) return "LOW";
  if (score <= 70) return "MEDIUM";
  return "HIGH";
}
