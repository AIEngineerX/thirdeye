import { describe, expect, test } from "bun:test";
import { type ParsedTx, analyzeTxPattern } from "../src/tx-patterns";

const T = "target";

function tx(
  ts: number,
  type: string,
  transfers: { from: string; to: string; amount: number }[] = [],
): ParsedTx {
  return {
    signature: `sig-${ts}`,
    timestamp: ts,
    type,
    source: null,
    destination: null,
    nativeTransfers: transfers.map((t) => ({
      fromUserAccount: t.from,
      toUserAccount: t.to,
      amount: t.amount,
    })),
  };
}

describe("analyzeTxPattern", () => {
  test("empty input returns zeros", () => {
    const p = analyzeTxPattern(T, []);
    expect(p.txCount).toBe(0);
    expect(p.avgGapSec).toBe(null);
    expect(p.swapOnly).toBe(false);
    expect(p.rapidFire).toBe(false);
  });

  test("rapid-fire detection (avg gap < 30s)", () => {
    const now = Math.floor(Date.now() / 1000);
    const txs = [tx(now - 60, "SWAP"), tx(now - 40, "SWAP"), tx(now - 20, "SWAP"), tx(now, "SWAP")];
    const p = analyzeTxPattern(T, txs);
    expect(p.rapidFire).toBe(true);
    expect(p.avgGapSec).toBe(20);
  });

  test("not rapid-fire when avg gap is large", () => {
    const now = Math.floor(Date.now() / 1000);
    const txs = [tx(now - 10_000, "SWAP"), tx(now - 5_000, "SWAP"), tx(now, "SWAP")];
    const p = analyzeTxPattern(T, txs);
    expect(p.rapidFire).toBe(false);
  });

  test("swapOnly true when all tx are SWAP", () => {
    const now = Math.floor(Date.now() / 1000);
    const txs = [tx(now, "SWAP"), tx(now - 100, "SWAP")];
    expect(analyzeTxPattern(T, txs).swapOnly).toBe(true);
  });

  test("swapOnly false when mixed types", () => {
    const now = Math.floor(Date.now() / 1000);
    const txs = [tx(now, "SWAP"), tx(now - 100, "TRANSFER")];
    expect(analyzeTxPattern(T, txs).swapOnly).toBe(false);
  });

  test("uniqueOutboundRecipients counts distinct destinations", () => {
    const now = Math.floor(Date.now() / 1000);
    const txs = [
      tx(now, "TRANSFER", [{ from: T, to: "r1", amount: 100 }]),
      tx(now - 10, "TRANSFER", [{ from: T, to: "r2", amount: 100 }]),
      tx(now - 20, "TRANSFER", [{ from: T, to: "r1", amount: 100 }]), // dup
      tx(now - 30, "TRANSFER", [{ from: "other", to: "r3", amount: 100 }]), // not from target
      tx(now - 40, "TRANSFER", [{ from: T, to: "r4", amount: 0 }]), // zero amount excluded
    ];
    expect(analyzeTxPattern(T, txs).uniqueOutboundRecipients).toBe(2);
  });

  test("ageDays computed from oldest tx", () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgo = now - 10 * 86_400;
    const p = analyzeTxPattern(T, [tx(tenDaysAgo, "SWAP"), tx(now, "SWAP")]);
    expect(p.ageDays).toBeGreaterThanOrEqual(9);
    expect(p.ageDays).toBeLessThanOrEqual(11);
  });
});
