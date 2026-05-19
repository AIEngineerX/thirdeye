import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { DbClient } from "@thirdeye/db";
import { runAgentLoop } from "../src/loop";
import { type ToolContext, tools } from "../src/tools";
import { recordedAnthropicClient } from "./replay";

const FIXTURE = path.join(import.meta.dir, "fixtures/runs/discovery-success.json");

// Stub DB that satisfies the getHotTokens query without touching Postgres.
const stubDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => [
            { mint: "MintAlpha", symbol: "ALPHA", mcUsd: "12345", mc24hPct: "8.4" },
          ],
        }),
      }),
    }),
  }),
} as unknown as DbClient;

const stubCtx: ToolContext = {
  db: stubDb,
  serverHeliusKey: undefined,
  smartMoneyMinSol: 50,
};

describe("runAgentLoop replay", () => {
  test("dispatches tools in fixture order, terminates on end_turn, computes cost", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-replay";
    const replay = recordedAnthropicClient(FIXTURE);

    const r = await runAgentLoop({
      kind: "discovery",
      systemPrompt: "Find hot tokens.",
      initialUserMessage: "What's hot?",
      modelTier: "cheap",
      maxToolCalls: 5,
      maxInputTokens: 50_000,
      serverHeliusKey: undefined,
      toolContext: stubCtx,
      toolsOverride: tools,
      clientOverride: replay.client,
    });

    expect(r.status).toBe("success");
    expect(r.toolCallsMade).toBe(1);
    expect(r.usage.inputTokens).toBe(2000);
    expect(r.usage.outputTokens).toBe(120);
    expect(r.usage.cacheReadTokens).toBe(1100);
    expect(r.usage.cacheCreationTokens).toBe(0);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.finalText).toContain("MintAlpha");
    expect(replay.callsMade()).toBe(2);
  });

  test("cap on maxToolCalls triggers status='capped'", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-replay";
    const replay = recordedAnthropicClient(FIXTURE);
    const r = await runAgentLoop({
      kind: "discovery",
      systemPrompt: "x",
      initialUserMessage: "x",
      modelTier: "cheap",
      maxToolCalls: 0,
      maxInputTokens: 50_000,
      serverHeliusKey: undefined,
      toolContext: stubCtx,
      toolsOverride: tools,
      clientOverride: replay.client,
    });
    expect(r.status).toBe("capped");
  });

  test("cap on maxInputTokens triggers status='capped'", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-replay";
    const replay = recordedAnthropicClient(FIXTURE);
    const r = await runAgentLoop({
      kind: "discovery",
      systemPrompt: "x",
      initialUserMessage: "x",
      modelTier: "cheap",
      maxToolCalls: 5,
      maxInputTokens: 100,
      serverHeliusKey: undefined,
      toolContext: stubCtx,
      toolsOverride: tools,
      clientOverride: replay.client,
    });
    expect(r.status).toBe("capped");
  });

  test("M6: pre-emptive cap fires BEFORE next API call when tool result is oversized", async () => {
    // Build a fake client that returns a tool_use that calls getHotTokens,
    // and a fake getHotTokens that returns a massive payload. With the old
    // post-call check, the cap would only fire AFTER paying for the
    // bloated next turn. With the pre-emptive check, it fires at the tool-
    // result step before another API call.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-replay";

    const callsRecorded: number[] = [];
    const fakeClient = async (req: { messages: { role: string }[] }) => {
      callsRecorded.push(req.messages.length);
      return {
        text: "",
        toolUses: [
          {
            id: "tu_1",
            name: "getHotTokens",
            input: { since: "1h", limit: 5 },
          },
        ],
        stopReason: "tool_use" as const,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        message: {
          id: "msg_1",
          type: "message" as const,
          role: "assistant" as const,
          stop_reason: "tool_use" as const,
          stop_sequence: null,
          model: "claude-haiku-4-5-20251001",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "tool_use" as const,
              id: "tu_1",
              name: "getHotTokens",
              input: { since: "1h", limit: 5 },
            },
          ],
        },
      };
    };

    // Tool that returns a 1 MB payload — would inflate the next turn's
    // input by ~400k tokens at our 2.5 chars/tok heuristic.
    const massive = "x".repeat(1_000_000);
    const fatToolDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [{ mint: massive, symbol: "BIG", mcUsd: "0", mc24hPct: "0" }],
            }),
          }),
        }),
      }),
    } as unknown as DbClient;

    const r = await runAgentLoop({
      kind: "discovery",
      systemPrompt: "x",
      initialUserMessage: "x",
      modelTier: "cheap",
      maxToolCalls: 5,
      maxInputTokens: 10_000, // tool result alone would push past this
      serverHeliusKey: undefined,
      toolContext: { ...stubCtx, db: fatToolDb },
      toolsOverride: tools,
      // biome-ignore lint/suspicious/noExplicitAny: stub matches CallModelResult shape
      clientOverride: fakeClient as unknown as any,
    });

    expect(r.status).toBe("capped");
    // The pre-emptive check should fire after the FIRST API call (which
    // returned the tool_use), before a second call sees the bloated input.
    expect(callsRecorded.length).toBe(1);
  });

  test("missing API key throws before calling client", async () => {
    // biome-ignore lint/performance/noDelete: Node coerces non-string env assignments to "undefined" string. delete is the only way to actually unset.
    delete process.env.ANTHROPIC_API_KEY;
    const replay = recordedAnthropicClient(FIXTURE);
    await expect(
      runAgentLoop({
        kind: "discovery",
        systemPrompt: "x",
        initialUserMessage: "x",
        modelTier: "cheap",
        maxToolCalls: 5,
        maxInputTokens: 50_000,
        serverHeliusKey: undefined,
        toolContext: stubCtx,
        toolsOverride: tools,
        clientOverride: replay.client,
      }),
    ).rejects.toThrow(/no anthropic api key/i);
  });
});
