import { describe, expect, test } from "bun:test";
import { projectWatchEventForAddress } from "../src/routes/watches/index";

const ADDR = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
const OTHER1 = "BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz";
const OTHER2 = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_OTHER = "So11111111111111111111111111111111111111112";

describe("projectWatchEventForAddress", () => {
  test("strips unrelated-party token transfers (H3)", () => {
    const payload = {
      signature: "sig1",
      timestamp: 1700000000,
      slot: 1234,
      source: "JUPITER",
      description: "swap",
      feePayer: OTHER1,
      fee: 5000,
      tokenTransfers: [
        // Unrelated transfer between two other accounts — must NOT leak
        { fromUserAccount: OTHER1, toUserAccount: OTHER2, mint: MINT_OTHER, tokenAmount: 100 },
        // Transfer involving the watched address — must be included
        { fromUserAccount: OTHER1, toUserAccount: ADDR, mint: MINT_USDC, tokenAmount: 250 },
      ],
      accountData: [
        // Unrelated account's native change — must not be included
        { account: OTHER2, nativeBalanceChange: -123 },
        // Watched address — must be included
        { account: ADDR, nativeBalanceChange: 250_000_000 },
      ],
    };

    const out = projectWatchEventForAddress(payload, ADDR);
    expect(out.source).toBe("JUPITER");
    expect(out.description).toBe("swap");
    expect(out.timestamp).toBe(1700000000);
    expect(out.slot).toBe(1234);
    // Fee leak: payer is someone else, so fee must NOT be exposed
    expect(out.feePayerIsAddress).toBe(false);
    expect(out.feeLamports).toBeNull();
    // nativeBalanceChange only for the watched address
    expect(out.nativeBalanceChange).toBe(250_000_000);
    // tokenTransfers filtered: only the one involving ADDR
    expect(out.tokenTransfers).toHaveLength(1);
    expect(out.tokenTransfers[0]!.mint).toBe(MINT_USDC);
    expect(out.tokenTransfers[0]!.direction).toBe("in");
    expect(out.tokenTransfers[0]!.counterparty).toBe(OTHER1);
  });

  test("surfaces fee when the watched address paid it", () => {
    const payload = {
      feePayer: ADDR,
      fee: 5000,
      tokenTransfers: [],
      accountData: [],
    };
    const out = projectWatchEventForAddress(payload, ADDR);
    expect(out.feePayerIsAddress).toBe(true);
    expect(out.feeLamports).toBe(5000);
  });

  test("outgoing token transfer direction + counterparty", () => {
    const payload = {
      tokenTransfers: [
        { fromUserAccount: ADDR, toUserAccount: OTHER1, mint: MINT_USDC, tokenAmount: 999 },
      ],
    };
    const out = projectWatchEventForAddress(payload, ADDR);
    expect(out.tokenTransfers).toHaveLength(1);
    expect(out.tokenTransfers[0]!.direction).toBe("out");
    expect(out.tokenTransfers[0]!.counterparty).toBe(OTHER1);
    expect(out.tokenTransfers[0]!.amount).toBe(999);
  });

  test("returns a defined shape for empty payload", () => {
    const out = projectWatchEventForAddress({}, ADDR);
    expect(out.source).toBeNull();
    expect(out.description).toBeNull();
    expect(out.feePayerIsAddress).toBe(false);
    expect(out.tokenTransfers).toEqual([]);
    expect(out.nativeBalanceChange).toBeNull();
  });

  test("ignores malformed fields without throwing", () => {
    const payload = {
      source: 12345, // wrong type
      timestamp: "not a number",
      // to === ADDR so this IS included, but the malformed sub-fields get nulled
      tokenTransfers: [{ fromUserAccount: 99, toUserAccount: ADDR, mint: null, tokenAmount: "x" }],
      accountData: "not an array",
    };
    const out = projectWatchEventForAddress(payload, ADDR);
    expect(out.source).toBeNull();
    expect(out.timestamp).toBeNull();
    expect(out.tokenTransfers).toHaveLength(1);
    expect(out.tokenTransfers[0]!.mint).toBeNull();
    expect(out.tokenTransfers[0]!.amount).toBeNull();
    expect(out.tokenTransfers[0]!.counterparty).toBeNull(); // wrong type
    expect(out.tokenTransfers[0]!.direction).toBe("in"); // to===ADDR
    expect(out.nativeBalanceChange).toBeNull();
  });

  test("null payload doesn't throw", () => {
    const out = projectWatchEventForAddress(null, ADDR);
    expect(out.tokenTransfers).toEqual([]);
  });
});
