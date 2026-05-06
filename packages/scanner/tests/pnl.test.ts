import { describe, expect, test } from "bun:test";
import { computeRealizedSolPnl } from "../src/pnl";
import type { ParsedTx } from "../src/tx-patterns";

const NOW = Math.floor(Date.now() / 1000);
const T = "TARGET";
const OTHER = "OTHER";

function swap(transfers: { from: string; to: string; amount: number }[], tsAgo = 0): ParsedTx {
  return {
    signature: `sig-${tsAgo}`,
    timestamp: NOW - tsAgo,
    type: "SWAP",
    source: null,
    destination: null,
    nativeTransfers: transfers.map((t) => ({
      fromUserAccount: t.from,
      toUserAccount: t.to,
      amount: t.amount,
    })),
  };
}

function transfer(transfers: { from: string; to: string; amount: number }[]): ParsedTx {
  return { ...swap(transfers, 0), type: "TRANSFER" };
}

describe("computeRealizedSolPnl", () => {
  test("zero on empty tx list", () => {
    expect(computeRealizedSolPnl(T, [])).toBe(0);
  });

  test("positive when wallet sells token for SOL (received SOL)", () => {
    // 1 SOL = 1e9 lamports; 5 SOL inflow
    const txs = [swap([{ from: OTHER, to: T, amount: 5_000_000_000 }])];
    expect(computeRealizedSolPnl(T, txs)).toBe(5);
  });

  test("negative when wallet buys token with SOL (sent SOL)", () => {
    const txs = [swap([{ from: T, to: OTHER, amount: 3_000_000_000 }])];
    expect(computeRealizedSolPnl(T, txs)).toBe(-3);
  });

  test("net across multiple swaps — buy then sell at gain", () => {
    const txs = [
      swap([{ from: T, to: OTHER, amount: 10_000_000_000 }]), // buy 10 SOL
      swap([{ from: OTHER, to: T, amount: 15_000_000_000 }]), // sell for 15
    ];
    expect(computeRealizedSolPnl(T, txs)).toBe(5);
  });

  test("ignores non-SWAP tx types", () => {
    const txs = [transfer([{ from: OTHER, to: T, amount: 100_000_000_000 }])];
    expect(computeRealizedSolPnl(T, txs)).toBe(0);
  });

  test("ignores tx outside 30d window", () => {
    const ago = 31 * 86_400; // 31 days
    const txs = [swap([{ from: OTHER, to: T, amount: 50_000_000_000 }], ago)];
    expect(computeRealizedSolPnl(T, txs)).toBe(0);
  });

  test("includes tx exactly within 30d window edge", () => {
    const ago = 29 * 86_400; // 29 days — well inside
    const txs = [swap([{ from: OTHER, to: T, amount: 1_000_000_000 }], ago)];
    expect(computeRealizedSolPnl(T, txs)).toBe(1);
  });

  test("ignores transfers not involving target", () => {
    const txs = [swap([{ from: "A", to: "B", amount: 1_000_000_000 }])];
    expect(computeRealizedSolPnl(T, txs)).toBe(0);
  });

  test("tx with both inbound and outbound nets correctly", () => {
    // Multi-leg swap where target both sends and receives within one tx —
    // should sum net (e.g. send 5, receive 7 = +2).
    const txs = [
      swap([
        { from: T, to: "router", amount: 5_000_000_000 },
        { from: "router", to: T, amount: 7_000_000_000 },
      ]),
    ];
    expect(computeRealizedSolPnl(T, txs)).toBe(2);
  });
});
