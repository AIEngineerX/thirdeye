import { describe, expect, test } from "bun:test";
import { QUICK_BUY_PLATFORMS, buildQuickBuyUrl } from "./quick-buy";

const MINT = "A3F7JL4eEG9YvXkqfqvQimncGmGvArZgjVdHNqUrpump";

describe("buildQuickBuyUrl", () => {
  test("gmgn is the verified default and builds a token URL", () => {
    expect(buildQuickBuyUrl("gmgn", MINT)).toBe(`https://gmgn.ai/sol/token/${MINT}`);
  });
  test("unsupported platform returns null (rendered disabled, never a silent 404)", () => {
    expect(buildQuickBuyUrl("photon", MINT)).toBeNull();
  });
  test("platform list marks support", () => {
    const gmgn = QUICK_BUY_PLATFORMS.find((p) => p.id === "gmgn");
    expect(gmgn?.supported).toBe(true);
    expect(QUICK_BUY_PLATFORMS.some((p) => p.supported === false)).toBe(true);
  });
});
