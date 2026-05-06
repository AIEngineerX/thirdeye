import { describe, expect, test } from "bun:test";
import { computeRisk, tokenVerdict } from "../src/risk";

describe("computeRisk", () => {
  test("zero everything → 0", () => {
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: false,
        maxClusterPct: 0,
        freshFunderCount: 0,
        totalClusters: 0,
      }),
    ).toBe(0);
  });

  test("clustered pct passes through 1:1", () => {
    expect(
      computeRisk({
        totalClusteredPct: 12,
        sybilFlag: false,
        maxClusterPct: 0,
        freshFunderCount: 0,
        totalClusters: 0,
      }),
    ).toBe(12);
  });

  test("sybil flag adds 25", () => {
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: true,
        maxClusterPct: 0,
        freshFunderCount: 0,
        totalClusters: 0,
      }),
    ).toBe(25);
  });

  test("maxClusterPct > 5 adds 15; ≤ 5 adds 0", () => {
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: false,
        maxClusterPct: 6,
        freshFunderCount: 0,
        totalClusters: 0,
      }),
    ).toBe(15);
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: false,
        maxClusterPct: 5,
        freshFunderCount: 0,
        totalClusters: 0,
      }),
    ).toBe(0);
  });

  test("freshFunder ratio scales by 10; clamped via /max(totalClusters,1)", () => {
    // 2/4 fresh = 0.5 → +5
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: false,
        maxClusterPct: 0,
        freshFunderCount: 2,
        totalClusters: 4,
      }),
    ).toBe(5);
    // ratio is 1.0 when totalClusters is 0 (divide-by-1) → +10
    expect(
      computeRisk({
        totalClusteredPct: 0,
        sybilFlag: false,
        maxClusterPct: 0,
        freshFunderCount: 1,
        totalClusters: 0,
      }),
    ).toBe(10);
  });

  test("clamped to 100", () => {
    expect(
      computeRisk({
        totalClusteredPct: 80,
        sybilFlag: true,
        maxClusterPct: 30,
        freshFunderCount: 5,
        totalClusters: 5,
      }),
    ).toBe(100);
  });

  test("realistic mid-risk case: 30% clustered + sybil + max>5 + 1/3 fresh → 73", () => {
    // 30 + 25 + 15 + (1/3)*10 = 30 + 25 + 15 + 3.33 = 73.33 → 73
    expect(
      computeRisk({
        totalClusteredPct: 30,
        sybilFlag: true,
        maxClusterPct: 12,
        freshFunderCount: 1,
        totalClusters: 3,
      }),
    ).toBe(73);
  });
});

describe("tokenVerdict", () => {
  test("0–10 is CLEAN", () => {
    expect(tokenVerdict(0)).toBe("CLEAN");
    expect(tokenVerdict(10)).toBe("CLEAN");
  });
  test("11–35 is LOW_RISK", () => {
    expect(tokenVerdict(11)).toBe("LOW_RISK");
    expect(tokenVerdict(35)).toBe("LOW_RISK");
  });
  test("36–100 is HIGH_RISK", () => {
    expect(tokenVerdict(36)).toBe("HIGH_RISK");
    expect(tokenVerdict(100)).toBe("HIGH_RISK");
  });
});
