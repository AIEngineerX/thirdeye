import { describe, expect, test } from "bun:test";
import { computeClusterCov } from "../src/cluster-cov";
import type { HeliusClient } from "../src/helius-client";
import type { ParsedTx } from "../src/tx-patterns";

// Build a fake HeliusClient where transactions(addr, n) returns canned
// nativeTransfers per address. Type-cast through unknown — only the one
// method is exercised.
function fakeClient(canned: Map<string, ParsedTx[]>): HeliusClient {
  return {
    transactions: async (addr: string, _limit: number) => canned.get(addr) ?? [],
  } as unknown as HeliusClient;
}

function txWithOutflow(from: string, amount: number, ts = 1700000000): ParsedTx {
  return {
    signature: `sig-${from}-${ts}-${amount}`,
    timestamp: ts,
    type: "TRANSFER",
    source: null,
    destination: null,
    nativeTransfers: [{ fromUserAccount: from, toUserAccount: "dest", amount }],
  };
}

describe("computeClusterCov", () => {
  test("returns null when fewer than 3 siblings", async () => {
    const cov = await computeClusterCov(fakeClient(new Map()), ["a", "b"], "target");
    expect(cov).toBe(null);
  });

  test("low CoV when all members send similar amounts (coordinated)", async () => {
    // 5 siblings, each sending ~100 lamports across 5 txs — uniform pattern.
    const canned = new Map<string, ParsedTx[]>();
    for (const m of ["a", "b", "c", "d", "e"]) {
      canned.set(m, [
        txWithOutflow(m, 100),
        txWithOutflow(m, 102),
        txWithOutflow(m, 99),
        txWithOutflow(m, 101),
        txWithOutflow(m, 100),
      ]);
    }
    const cov = await computeClusterCov(fakeClient(canned), ["a", "b", "c", "d", "e"], "target");
    expect(cov).not.toBe(null);
    expect(cov!).toBeLessThan(0.05); // strong coordination signal
  });

  test("high CoV when amounts vary widely (organic)", async () => {
    const canned = new Map<string, ParsedTx[]>();
    canned.set("a", [
      txWithOutflow("a", 10),
      txWithOutflow("a", 100),
      txWithOutflow("a", 1000),
      txWithOutflow("a", 5000),
      txWithOutflow("a", 50),
    ]);
    canned.set("b", [
      txWithOutflow("b", 5000),
      txWithOutflow("b", 50),
      txWithOutflow("b", 1),
      txWithOutflow("b", 200),
      txWithOutflow("b", 8000),
    ]);
    canned.set("c", [
      txWithOutflow("c", 1),
      txWithOutflow("c", 20000),
      txWithOutflow("c", 500),
      txWithOutflow("c", 5),
      txWithOutflow("c", 100),
    ]);
    const cov = await computeClusterCov(fakeClient(canned), ["a", "b", "c"], "target");
    expect(cov).not.toBe(null);
    expect(cov!).toBeGreaterThan(0.2);
  });

  test("excludes target address from sample", async () => {
    // 3 siblings + target. Target should not be queried.
    const calledFor: string[] = [];
    const tracker: HeliusClient = {
      transactions: async (addr: string) => {
        calledFor.push(addr);
        return [
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
        ];
      },
    } as unknown as HeliusClient;
    await computeClusterCov(tracker, ["target", "a", "b", "c"], "target");
    expect(calledFor).not.toContain("target");
    expect(calledFor.sort()).toEqual(["a", "b", "c"]);
  });

  test("skips members with too few tx samples", async () => {
    // a: 2 outflows (below 5 threshold) → excluded by computeCov
    // b, c, d: 5 outflows each — uniform
    const canned = new Map<string, ParsedTx[]>();
    canned.set("a", [txWithOutflow("a", 100), txWithOutflow("a", 100)]);
    for (const m of ["b", "c", "d"]) {
      canned.set(m, [
        txWithOutflow(m, 50),
        txWithOutflow(m, 50),
        txWithOutflow(m, 50),
        txWithOutflow(m, 50),
        txWithOutflow(m, 50),
      ]);
    }
    const cov = await computeClusterCov(fakeClient(canned), ["a", "b", "c", "d"], "target");
    expect(cov).not.toBe(null);
    // 3 wallets all averaging exactly 50 → CoV is 0
    expect(cov!).toBeLessThan(0.01);
  });

  test("per-member fetch error is non-fatal", async () => {
    let callCount = 0;
    const flakyClient: HeliusClient = {
      transactions: async (addr: string) => {
        callCount++;
        if (addr === "b") throw new Error("simulated 429");
        return [
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
          txWithOutflow(addr, 100),
        ];
      },
    } as unknown as HeliusClient;
    const cov = await computeClusterCov(flakyClient, ["a", "b", "c", "d"], "target");
    // 3 of 4 succeeded — still ≥3 sample threshold; CoV computes from a/c/d
    expect(cov).not.toBe(null);
    expect(callCount).toBe(4);
  });
});
