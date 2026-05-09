import pricingTable from "../tests/fixtures/pricing.json" with { type: "json" };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation5m: number;
}

const RATES = pricingTable.rates as Record<string, ModelRates>;

export function computeCost(usage: TokenUsage, model: string): number {
  const rates = RATES[model];
  if (!rates) {
    throw new Error(`no pricing row for model "${model}" — add it to tests/fixtures/pricing.json`);
  }
  return (
    (usage.inputTokens / 1_000_000) * rates.input +
    (usage.outputTokens / 1_000_000) * rates.output +
    (usage.cacheReadTokens / 1_000_000) * rates.cacheRead +
    (usage.cacheCreationTokens / 1_000_000) * rates.cacheCreation5m
  );
}
