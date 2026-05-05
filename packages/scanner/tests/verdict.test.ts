import { describe, expect, test } from "bun:test";
import { computeVerdict } from "../src/verdict";

describe("computeVerdict", () => {
  test("EXCHANGE wins over everything", () => {
    expect(computeVerdict({ tags: ["EXCHANGE", "BUNDLER", "SYBIL"], txCount: 100 })).toBe(
      "EXCHANGE",
    );
  });
  test("SYBIL beats BUNDLER", () => {
    expect(computeVerdict({ tags: ["BUNDLER", "SYBIL"], txCount: 100 })).toBe("SYBIL");
  });
  test("BUNDLER without SYBIL", () => {
    expect(computeVerdict({ tags: ["BUNDLER"], txCount: 100 })).toBe("BUNDLER");
  });
  test("SNIPER BOT", () => {
    expect(computeVerdict({ tags: ["SNIPER"], txCount: 200 })).toBe("SNIPER BOT");
  });
  test("WHALE only when not BUNDLER/SNIPER", () => {
    expect(computeVerdict({ tags: ["WHALE"], txCount: 10 })).toBe("WHALE");
    expect(computeVerdict({ tags: ["WHALE", "BUNDLER"], txCount: 10 })).toBe("BUNDLER");
    expect(computeVerdict({ tags: ["WHALE", "SNIPER"], txCount: 10 })).toBe("SNIPER BOT");
  });
  test("FRESH only with single tag", () => {
    expect(computeVerdict({ tags: ["FRESH_WALLET"], txCount: 5 })).toBe("FRESH");
    expect(computeVerdict({ tags: ["FRESH_WALLET", "BUNDLER"], txCount: 5 })).toBe("BUNDLER");
  });
  test("TRADER when txCount >= 50 and no risk tags", () => {
    expect(computeVerdict({ tags: [], txCount: 60 })).toBe("TRADER");
    expect(computeVerdict({ tags: ["WHALE"], txCount: 60 })).toBe("WHALE");
  });
  test("CLEAN otherwise", () => {
    expect(computeVerdict({ tags: [], txCount: 10 })).toBe("CLEAN");
  });
});
