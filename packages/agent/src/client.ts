import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  TextBlock,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { AgentTool } from "./tools";

export interface CallModelOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: AgentTool[];
  messages: MessageParam[];
  maxTokens: number;
}

export interface CallModelResult {
  message: Message;
  toolUses: ToolUseBlock[];
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  stopReason: Message["stop_reason"];
}

export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  // Cache control marks system prompt + (last) tool definition with
  // type:'ephemeral'. The cache breakpoint applies to everything up to
  // and including that block, so one mark on the trailing tool caches
  // the entire tool list along with the system prompt. Reads bill at
  // 0.1x base input, the largest cost lever in spec §3.
  const sdkTools: Tool[] = opts.tools.map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));

  const message = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [{ type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } }],
    tools: sdkTools,
    messages: opts.messages,
  });

  const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const text = message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    message,
    toolUses,
    text,
    usage: {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    stopReason: message.stop_reason,
  };
}
