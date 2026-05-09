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

  test("missing API key throws before calling client", async () => {
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
