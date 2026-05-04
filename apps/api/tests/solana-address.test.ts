import { describe, expect, test } from "bun:test";
import { isValidSolanaAddress } from "../src/lib/solana-address";

describe("isValidSolanaAddress", () => {
  test("accepts valid 44-char base58", () => {
    expect(isValidSolanaAddress("BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz")).toBe(true);
  });

  test("accepts shorter valid base58 (32 chars min)", () => {
    expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
  });

  test("rejects too short", () => {
    expect(isValidSolanaAddress("abc")).toBe(false);
    expect(isValidSolanaAddress("1".repeat(31))).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidSolanaAddress("a".repeat(50))).toBe(false);
    expect(isValidSolanaAddress("1".repeat(45))).toBe(false);
  });

  test("rejects characters outside base58 alphabet (0/O/I/l)", () => {
    expect(isValidSolanaAddress("0OIl11111111111111111111111111111")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });

  test("rejects non-base58 characters", () => {
    expect(isValidSolanaAddress("not-a-real-addr-with-hyphens-1234")).toBe(false);
  });
});
