import { describe, expect, test } from "bun:test";
import {
  fmtClockMs,
  fmtDaysUntil,
  fmtInt,
  fmtMoneyCompact,
  fmtNumber,
  fmtPct,
  fmtRelative,
  fmtRelativeMs,
  fmtSol,
  fmtUsd,
  fmtUsdCompact,
  fmtUsdSigned,
  isValidSolanaAddress,
  shortAddr,
} from "./format";

describe("format", () => {
  test("shortAddr truncates long addresses", () => {
    expect(shortAddr("Bxyz9abcdefghijklmnopqrstuvwxyz0123456789mnp7")).toBe("Bxyz…mnp7");
  });

  test("shortAddr leaves short strings alone", () => {
    expect(shortAddr("abc")).toBe("abc");
  });

  test("fmtInt thousands separator", () => {
    expect(fmtInt(1247)).toBe("1,247");
    expect(fmtInt(0)).toBe("0");
  });

  test("fmtNumber with decimals", () => {
    expect(fmtNumber(1234.5, 2)).toBe("1,234.50");
    expect(fmtNumber(0, 2)).toBe("0.00");
  });

  test("fmtSol signs + decimals", () => {
    expect(fmtSol(47.3)).toBe("+47.30 SOL");
    expect(fmtSol(-12.4)).toBe("−12.40 SOL");
    expect(fmtSol(0)).toBe("0.00 SOL");
    expect(fmtSol(null)).toBe("—");
  });

  test("fmtUsdCompact K/M/B suffixes, unsigned", () => {
    expect(fmtUsdCompact(40_962_971.2)).toBe("$40.96M");
    expect(fmtUsdCompact(1_500_000_000)).toBe("$1.50B");
    expect(fmtUsdCompact(8121.04)).toBe("$8.1K");
    expect(fmtUsdCompact(42.5)).toBe("$42.50");
    expect(fmtUsdCompact(-8121.04)).toBe("$8.1K"); // compact is unsigned
    expect(fmtUsdCompact(null)).toBe("—");
  });

  test("fmtUsdSigned adds +/− on compact USD", () => {
    expect(fmtUsdSigned(40_962_971.2)).toBe("+$40.96M");
    expect(fmtUsdSigned(-1234)).toBe("−$1.2K");
    expect(fmtUsdSigned(0)).toBe("$0.00");
    expect(fmtUsdSigned(null)).toBe("—");
  });

  test("fmtRelativeMs buckets from epoch ms", () => {
    const now = 1_700_000_000_000;
    expect(fmtRelativeMs(now - 5_000, now)).toBe("5s ago");
    expect(fmtRelativeMs(now - 4 * 60_000, now)).toBe("4m ago");
    expect(fmtRelativeMs(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(fmtRelativeMs(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(fmtRelativeMs(Number.NaN, now)).toBe("—");
  });

  test("fmtPct", () => {
    expect(fmtPct(73)).toBe("73.00%");
    expect(fmtPct(12.345, 1)).toBe("12.3%");
    expect(fmtPct(null)).toBe("—");
  });

  test("fmtUsd", () => {
    expect(fmtUsd(84012)).toBe("$84,012.00");
    expect(fmtUsd(null)).toBe("—");
  });

  test("fmtClockMs", () => {
    const iso = "2026-05-20T15:42:11.041Z";
    // Don't assert timezone-specific output — just shape
    const out = fmtClockMs(iso);
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test("fmtRelative", () => {
    const now = Date.parse("2026-05-20T12:00:00Z");
    expect(fmtRelative("2026-05-20T11:59:48Z", now)).toBe("12s ago");
    expect(fmtRelative("2026-05-20T11:55:00Z", now)).toBe("5m ago");
    expect(fmtRelative("2026-05-20T09:00:00Z", now)).toBe("3h ago");
    expect(fmtRelative("2026-05-17T12:00:00Z", now)).toBe("3d ago");
  });

  test("fmtDaysUntil", () => {
    const now = Date.parse("2026-05-20T12:00:00Z");
    expect(fmtDaysUntil("2026-05-20T12:00:30Z", now)).toBe("30s");
    expect(fmtDaysUntil("2026-05-20T12:05:00Z", now)).toBe("5m");
    expect(fmtDaysUntil("2026-05-20T18:00:00Z", now)).toBe("6h");
    expect(fmtDaysUntil("2026-05-27T12:00:00Z", now)).toBe("7d");
  });

  test("fmtMoneyCompact k/m/b suffixes lowercase", () => {
    expect(fmtMoneyCompact(75_000)).toBe("$75k");
    expect(fmtMoneyCompact(1_200_000)).toBe("$1.2m");
    expect(fmtMoneyCompact(2_400_000_000)).toBe("$2.4b");
    expect(fmtMoneyCompact(500)).toBe("$500");
    expect(fmtMoneyCompact(null)).toBe("—");
  });

  test("isValidSolanaAddress", () => {
    // Wrapped SOL mint
    expect(isValidSolanaAddress("So11111111111111111111111111111111111111112")).toBe(true);
    // USDC mint
    expect(isValidSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isValidSolanaAddress("short")).toBe(false);
    // Contains banned base58 chars (0, O, I, l)
    expect(isValidSolanaAddress("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBe(false);
  });
});
