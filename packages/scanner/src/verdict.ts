import type { Tag, Verdict } from "./types";

export interface VerdictInputs {
  tags: Tag[];
  txCount: number;
}

export function computeVerdict(inputs: VerdictInputs): Verdict {
  const has = (t: Tag): boolean => inputs.tags.includes(t);
  // Risk tags first — these dominate even if SMART_MONEY also fires (a
  // bundler making realized PnL is still a bundler from a labelling
  // perspective; the score reflects both signals).
  if (has("EXCHANGE")) return "EXCHANGE";
  if (has("SYBIL")) return "SYBIL";
  if (has("BUNDLER")) return "BUNDLER";
  if (has("SNIPER")) return "SNIPER BOT";
  // Phase 5d: SMART_MONEY ranks above WHALE (a profitable trader is more
  // useful to know about than a passive bag-holder of similar USD value).
  if (has("SMART_MONEY")) return "SMART_MONEY";
  if (has("WHALE") && !has("BUNDLER") && !has("SNIPER")) return "WHALE";
  if (has("FRESH_WALLET") && inputs.tags.length === 1) return "FRESH";
  const riskTags: Tag[] = ["BUNDLER", "BUNDLER_TIGHT", "SYBIL", "SNIPER", "FUND_DISTRIBUTOR"];
  const hasRisk = riskTags.some((t) => has(t));
  if (inputs.txCount >= 50 && !hasRisk) return "TRADER";
  return "CLEAN";
}
