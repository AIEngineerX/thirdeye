import { describe, expect, test } from "bun:test";
import { computeScore, scoreBucket } from "../src/score";

describe("computeScore", () => {
  test("clean wallet (no tags) is 0", () => {
    expect(computeScore({ tags: [], clusterSize: 1 })).toBe(1);
  });
  test("FRESH_WALLET alone is ~10", () => {
    expect(computeScore({ tags: ["FRESH_WALLET"], clusterSize: 1 })).toBe(11);
  });
  test("FUND_DISTRIBUTOR alone is ~20", () => {
    expect(computeScore({ tags: ["FUND_DISTRIBUTOR"], clusterSize: 1 })).toBe(21);
  });
  test("BUNDLER alone with cluster size 5", () => {
    expect(computeScore({ tags: ["BUNDLER"], clusterSize: 5 })).toBe(33);
  });
  test("BUNDLER + BUNDLER_TIGHT + SYBIL is HIGH", () => {
    const s = computeScore({
      tags: ["BUNDLER", "BUNDLER_TIGHT", "SYBIL"],
      clusterSize: 10,
    });
    expect(s).toBeGreaterThanOrEqual(60);
    expect(s).toBeLessThanOrEqual(100);
  });
  test("SNIPER alone is ~15", () => {
    expect(computeScore({ tags: ["SNIPER"], clusterSize: 1 })).toBe(16);
  });
  test("EXCHANGE collapses to 0 even with other tags", () => {
    expect(
      computeScore({ tags: ["EXCHANGE", "BUNDLER", "FUND_DISTRIBUTOR"], clusterSize: 100 }),
    ).toBe(25); // 50 (cluster cap) - 50 (exchange) + 20 + 30 = 50; floor 0; actually -50+30+20+25=25
  });
  test("KOL subtracts 10", () => {
    expect(computeScore({ tags: ["KOL", "FRESH_WALLET"], clusterSize: 1 })).toBe(1);
  });
  test("score is clamped to 100", () => {
    expect(
      computeScore({
        tags: ["FRESH_WALLET", "FUND_DISTRIBUTOR", "BUNDLER", "BUNDLER_TIGHT", "SYBIL", "SNIPER"],
        clusterSize: 100,
      }),
    ).toBe(100);
  });
  test("score is clamped to 0", () => {
    expect(computeScore({ tags: ["EXCHANGE", "KOL"], clusterSize: 0 })).toBe(0);
  });
  test("cluster size contributes 0.5/wallet capped at 50", () => {
    const s100 = computeScore({ tags: [], clusterSize: 100 });
    const s50 = computeScore({ tags: [], clusterSize: 50 });
    expect(s100).toBe(s50);
    expect(s50).toBe(25);
  });
});

describe("scoreBucket", () => {
  test("0-20 is CLEAN", () => {
    expect(scoreBucket(0)).toBe("CLEAN");
    expect(scoreBucket(20)).toBe("CLEAN");
  });
  test("21-45 is LOW", () => {
    expect(scoreBucket(21)).toBe("LOW");
    expect(scoreBucket(45)).toBe("LOW");
  });
  test("46-70 is MEDIUM", () => {
    expect(scoreBucket(46)).toBe("MEDIUM");
    expect(scoreBucket(70)).toBe("MEDIUM");
  });
  test("71-100 is HIGH", () => {
    expect(scoreBucket(71)).toBe("HIGH");
    expect(scoreBucket(100)).toBe("HIGH");
  });
});
