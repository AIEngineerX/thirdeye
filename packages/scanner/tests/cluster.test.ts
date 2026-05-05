import { describe, expect, test } from "bun:test";
import { buildCluster, computeCov } from "../src/cluster";
import type { Identity } from "../src/types";

describe("computeCov", () => {
  test("returns null when fewer than 3 wallets have ≥5 tx", () => {
    expect(computeCov(new Map())).toBe(null);
    expect(
      computeCov(
        new Map([
          ["a", [1, 2, 3, 4, 5]],
          ["b", [1, 2, 3, 4]], // < 5 ignored
        ]),
      ),
    ).toBe(null);
  });

  test("low CoV indicates coordinated sizing (< 0.15 threshold)", () => {
    const amounts = new Map([
      ["a", [100, 100, 100, 100, 100]],
      ["b", [100, 102, 99, 101, 100]],
      ["c", [101, 100, 100, 99, 100]],
    ]);
    const cov = computeCov(amounts)!;
    expect(cov).toBeLessThan(0.05);
  });

  test("high CoV indicates organic variation", () => {
    const amounts = new Map([
      ["a", [10, 100, 1000, 10_000, 50]],
      ["b", [5_000, 50, 1, 200, 8_000]],
      ["c", [1, 20_000, 500, 5, 100]],
    ]);
    const cov = computeCov(amounts)!;
    expect(cov).toBeGreaterThan(0.2);
  });

  test("returns null when mean is 0", () => {
    const amounts = new Map([
      ["a", [0, 0, 0, 0, 0]],
      ["b", [0, 0, 0, 0, 0]],
      ["c", [0, 0, 0, 0, 0]],
    ]);
    expect(computeCov(amounts)).toBe(null);
  });
});

describe("buildCluster", () => {
  const identity: Identity = { address: "x", name: null, type: null, category: null };
  test("excludes target from siblings", () => {
    const c = buildCluster({
      targetAddress: "target",
      targetFundedAt: null,
      firstFunder: "F",
      rawSiblings: [
        { address: "target", fundedAt: null },
        { address: "sib1", fundedAt: null },
      ],
      identitiesByAddress: new Map([["sib1", { ...identity, address: "sib1" }]]),
      clusterTxAmounts: new Map(),
    });
    expect(c.siblings).toHaveLength(1);
    expect(c.siblings[0]!.address).toBe("sib1");
    expect(c.size).toBe(2); // siblings.length + 1 (target)
  });

  test("time-window siblings within 5min", () => {
    const targetTime = "2026-05-04T12:00:00Z";
    const c = buildCluster({
      targetAddress: "T",
      targetFundedAt: targetTime,
      firstFunder: "F",
      rawSiblings: [
        { address: "tight", fundedAt: "2026-05-04T12:02:00Z" }, // within 5 min
        { address: "loose", fundedAt: "2026-05-04T13:00:00Z" }, // outside 5 min
        { address: "edge", fundedAt: "2026-05-04T12:05:00Z" }, // exactly 5 min — included
      ],
      identitiesByAddress: new Map(),
      clusterTxAmounts: new Map(),
    });
    expect(c.timeWindowSiblings.sort()).toEqual(["edge", "tight"]);
  });

  test("no time-window siblings when targetFundedAt is null", () => {
    const c = buildCluster({
      targetAddress: "T",
      targetFundedAt: null,
      firstFunder: "F",
      rawSiblings: [{ address: "sib", fundedAt: "2026-05-04T12:00:00Z" }],
      identitiesByAddress: new Map(),
      clusterTxAmounts: new Map(),
    });
    expect(c.timeWindowSiblings).toEqual([]);
  });
});
