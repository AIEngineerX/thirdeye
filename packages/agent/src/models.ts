export type ModelTier = "cheap" | "reasoning";

const PINNED = {
  cheap: "claude-haiku-4-5-20251001",
  reasoning: "claude-sonnet-4-6",
} as const;

export function resolveModel(tier: ModelTier): string {
  if (tier === "cheap") return process.env.AGENT_CHEAP_MODEL ?? PINNED.cheap;
  return process.env.AGENT_REASONING_MODEL ?? PINNED.reasoning;
}

export const PINNED_MODELS = PINNED;
