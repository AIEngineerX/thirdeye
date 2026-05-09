import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/models";

describe("resolveModel", () => {
  test("returns pinned cheap model when env unset", () => {
    delete process.env.AGENT_CHEAP_MODEL;
    expect(resolveModel("cheap")).toBe("claude-haiku-4-5-20251001");
  });

  test("returns pinned reasoning model when env unset", () => {
    delete process.env.AGENT_REASONING_MODEL;
    expect(resolveModel("reasoning")).toBe("claude-sonnet-4-6");
  });

  test("env override takes precedence", () => {
    process.env.AGENT_CHEAP_MODEL = "claude-haiku-future-id";
    expect(resolveModel("cheap")).toBe("claude-haiku-future-id");
    delete process.env.AGENT_CHEAP_MODEL;
  });
});
