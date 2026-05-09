import { describe, expect, test } from "bun:test";
import { PINNED_MODELS } from "../src/models";
import { computeCost } from "../src/pricing";
import pricingFixture from "./fixtures/pricing.json";

describe("computeCost", () => {
  test("zero usage returns 0", () => {
    expect(
      computeCost(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        PINNED_MODELS.cheap,
      ),
    ).toBe(0);
  });

  test("Haiku 4.5: 1M input + 1M output = $1.00 + $5.00 = $6.00", () => {
    const got = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      PINNED_MODELS.cheap,
    );
    const rates = pricingFixture.rates[PINNED_MODELS.cheap];
    expect(got).toBeCloseTo(rates.input + rates.output, 4);
  });

  test("Sonnet 4.6: cache_read tokens billed at 0.1x rate, not full input rate", () => {
    const rates = pricingFixture.rates[PINNED_MODELS.reasoning];
    const got = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 500_000,
        cacheCreationTokens: 0,
      },
      PINNED_MODELS.reasoning,
    );
    expect(got).toBeCloseTo(rates.input + 0.5 * rates.cacheRead, 4);
  });

  test("Haiku 4.5: cache_creation tokens billed at 5m write rate (1.25x base)", () => {
    const rates = pricingFixture.rates[PINNED_MODELS.cheap];
    const got = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 1_000_000,
      },
      PINNED_MODELS.cheap,
    );
    expect(got).toBeCloseTo(rates.cacheCreation5m, 4);
  });

  test("every pinned model has a pricing row", () => {
    for (const id of Object.values(PINNED_MODELS)) {
      expect(pricingFixture.rates).toHaveProperty(id);
    }
  });

  test("unknown model throws (forces explicit pricing for new models)", () => {
    expect(() =>
      computeCost(
        { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        "claude-future-unknown",
      ),
    ).toThrow(/no pricing row/i);
  });
});
