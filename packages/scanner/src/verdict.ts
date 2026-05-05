import type { Tag, Verdict } from "./types";

export interface VerdictInputs {
  tags: Tag[];
  txCount: number;
}

export function computeVerdict(inputs: VerdictInputs): Verdict {
  const has = (t: Tag): boolean => inputs.tags.includes(t);
  if (has("EXCHANGE")) return "EXCHANGE";
  if (has("SYBIL")) return "SYBIL";
  if (has("BUNDLER")) return "BUNDLER";
  if (has("SNIPER")) return "SNIPER BOT";
  if (has("WHALE") && !has("BUNDLER") && !has("SNIPER")) return "WHALE";
  if (has("FRESH_WALLET") && inputs.tags.length === 1) return "FRESH";
  const riskTags: Tag[] = ["BUNDLER", "BUNDLER_TIGHT", "SYBIL", "SNIPER", "FUND_DISTRIBUTOR"];
  const hasRisk = riskTags.some((t) => has(t));
  if (inputs.txCount >= 50 && !hasRisk) return "TRADER";
  return "CLEAN";
}
