import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { type CallModelResult, callModel } from "./client";
import { resolveModel } from "./models";
import { type TokenUsage, computeCost } from "./pricing";
import { type ToolContext, getToolByName, tools as defaultTools } from "./tools";
import type { AgentRunOptions } from "./types";

export interface LoopResult {
  status: "success" | "capped";
  finalText: string;
  usage: TokenUsage;
  costUsd: number;
  toolCallsMade: number;
}

const MAX_OUTPUT_TOKENS = 4096;
// Defends against pathological loops the cap math misses (e.g. model
// keeps emitting tool_use blocks the model never satisfies). 50 is
// well above the legitimate AGENT_MAX_TOOL_CALLS_PER_RUN cap of 20.
const HARD_ITER_LIMIT = 50;

type ClientFn = typeof callModel;

export interface RunAgentLoopOptions extends AgentRunOptions {
  toolContext: ToolContext;
  // Replay tests inject a recorded client. Production passes nothing.
  clientOverride?: ClientFn;
  // Replay tests can substitute a smaller tool set; production uses the registry.
  toolsOverride?: typeof defaultTools;
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<LoopResult> {
  const apiKey = opts.anthropicKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("no Anthropic API key (BYOK header missing and ANTHROPIC_API_KEY env unset)");

  const model = resolveModel(opts.modelTier);
  const tools = opts.toolsOverride ?? defaultTools;
  const client: ClientFn = opts.clientOverride ?? callModel;

  const messages: MessageParam[] = [{ role: "user", content: opts.initialUserMessage }];
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let toolCallsMade = 0;
  let finalText = "";

  for (let iter = 0; iter < HARD_ITER_LIMIT; iter++) {
    const r: CallModelResult = await client({
      apiKey,
      model,
      systemPrompt: opts.systemPrompt,
      tools,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.cacheReadTokens += r.usage.cacheReadTokens;
    usage.cacheCreationTokens += r.usage.cacheCreationTokens;
    if (r.text) finalText = r.text;

    // Cap check #1: cumulative input tokens (counts uncached input only,
    // matching the bill — cached reads + creations have their own rates).
    if (usage.inputTokens > opts.maxInputTokens) {
      return {
        status: "capped",
        finalText,
        usage,
        costUsd: computeCost(usage, model),
        toolCallsMade,
      };
    }

    if (r.stopReason !== "tool_use" || r.toolUses.length === 0) {
      return {
        status: "success",
        finalText,
        usage,
        costUsd: computeCost(usage, model),
        toolCallsMade,
      };
    }

    // Append assistant turn (the full content blocks, including tool_use)
    // so the next request sees the conversation history.
    messages.push({ role: "assistant", content: r.message.content });

    // Dispatch each tool_use, build tool_result blocks.
    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of r.toolUses) {
      toolCallsMade++;
      // Cap check #2: tool call count
      if (toolCallsMade > opts.maxToolCalls) {
        return {
          status: "capped",
          finalText,
          usage,
          costUsd: computeCost(usage, model),
          toolCallsMade,
        };
      }
      const tool = getToolByName(tu.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: `unknown_tool: ${tu.name}` }),
          is_error: true,
        });
        continue;
      }
      try {
        const out = await tool.handler(tu.input, opts.toolContext);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out),
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Hit hard iteration limit without natural termination — treat as capped
  // so the budget gate records cost faithfully.
  return {
    status: "capped",
    finalText,
    usage,
    costUsd: computeCost(usage, model),
    toolCallsMade,
  };
}
