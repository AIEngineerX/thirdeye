import { describe, expect, test } from "bun:test";
import { traceFundingChain } from "../src/funding-chain";

const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

function fakeResolver(graph: Record<string, string | null>) {
  return async (addr: string) => ({
    funder: graph[addr] ?? null,
    signature: graph[addr] ? `sig-${addr}` : null,
    fundedAt: graph[addr] ? "2026-05-04T12:00:00Z" : null,
  });
}

describe("traceFundingChain", () => {
  test("stops at maxHops", async () => {
    const graph: Record<string, string> = {
      A: "B",
      B: "C",
      C: "D",
      D: "E",
      E: "F",
    };
    const chain = await traceFundingChain({
      startAddress: "A",
      maxHops: 3,
      resolveFundedBy: fakeResolver(graph),
    });
    expect(chain).toHaveLength(3);
    expect(chain.map((h) => h.address)).toEqual(["A", "B", "C"]);
  });

  test("stops on exchange address", async () => {
    const graph: Record<string, string> = {
      A: "B",
      B: BINANCE,
      [BINANCE]: "X",
    };
    const chain = await traceFundingChain({
      startAddress: "A",
      maxHops: 5,
      resolveFundedBy: fakeResolver(graph),
    });
    expect(chain).toHaveLength(2);
    expect(chain[1]!.funder).toBe(BINANCE);
    expect(chain[1]!.isExchange).toBe(true);
  });

  test("stops on null funder (genesis/unfunded)", async () => {
    const chain = await traceFundingChain({
      startAddress: "A",
      maxHops: 5,
      resolveFundedBy: fakeResolver({ A: "B", B: null as unknown as string }),
    });
    expect(chain).toHaveLength(2);
    expect(chain[1]!.funder).toBe(null);
  });

  test("guards against cycles", async () => {
    const graph: Record<string, string> = { A: "B", B: "A" };
    const chain = await traceFundingChain({
      startAddress: "A",
      maxHops: 10,
      resolveFundedBy: fakeResolver(graph),
    });
    expect(chain).toHaveLength(2);
  });
});
