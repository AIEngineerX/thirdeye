import { describe, expect, test } from "bun:test";
import {
  fmtClockMs,
  fmtDaysUntil,
  fmtInt,
  fmtNumber,
  fmtPct,
  fmtRelative,
  fmtSol,
  fmtUsd,
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
