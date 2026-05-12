import type { TokenUsage } from "./pricing";

export type AgentRunKind =
  | "discovery"
  | "anomaly"
  | "morning_brief"
  | "cluster_expand"
  | "tg_query";

export interface AgentRunOptions {
  kind: AgentRunKind;
  systemPrompt: string;
  initialUserMessage: string;
  modelTier: "cheap" | "reasoning";
  // BYOK passthrough
  anthropicKey?: string | undefined;
  serverHeliusKey: string | undefined;
  userHeliusKey?: string | undefined;
  // Caps (defaults pulled from env at call site)
  maxToolCalls: number;
  maxInputTokens: number;
  // Metadata persisted to agent_runs.metadata
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  runId: number;
  status: "success" | "failed" | "skipped_budget" | "capped";
  finalText: string | null;
  usage: TokenUsage;
  costUsd: number;
  toolCallsMade: number;
  errorMessage: string | null;
}
