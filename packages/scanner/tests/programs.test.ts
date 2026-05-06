import { describe, expect, test } from "bun:test";
import { LOCKER_PROGRAMS, RAYDIUM_PROGRAMS, isLpOrLockOwner } from "@thirdeye/shared";

describe("isLpOrLockOwner", () => {
  test("Raydium AMM v4 → lp", () => {
    expect(isLpOrLockOwner("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")).toBe("lp");
  });

  test("Streamflow → locked", () => {
    expect(isLpOrLockOwner("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m")).toBe("locked");
  });

  test("unknown wallet → null", () => {
    expect(isLpOrLockOwner("BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNNz")).toBe(null);
  });

  test("null/undefined input → null", () => {
    expect(isLpOrLockOwner(null)).toBe(null);
    expect(isLpOrLockOwner(undefined)).toBe(null);
  });

  test("LP and locker sets are disjoint", () => {
    for (const lp of RAYDIUM_PROGRAMS) {
      expect(LOCKER_PROGRAMS.has(lp)).toBe(false);
    }
  });
});
