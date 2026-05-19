import { describe, expect, test } from "bun:test";
import { clampInt } from "../src/lib/http";

describe("clampInt", () => {
  test("uses fallback on undefined", () => {
    expect(clampInt(undefined, 50, 1, 200)).toBe(50);
  });

  test("clamps to [min, max]", () => {
    expect(clampInt("999", 50, 1, 200)).toBe(200);
    expect(clampInt("0", 50, 1, 200)).toBe(1);
    expect(clampInt("75", 50, 1, 200)).toBe(75);
  });

  test("non-numeric falls back", () => {
    expect(clampInt("garbage", 50, 1, 200)).toBe(50);
    expect(clampInt("", 50, 1, 200)).toBe(50);
  });

  test("Bug-L5: scientific notation falls back instead of misleading 1", () => {
    // Old: Number.parseInt("1e10", 10) → 1 → clamps to min=1, totally wrong.
    // New: Number("1e10") → 1e10 → trunc → too big, clamps to max=200.
    // Either behavior is defensible; what matters is no longer being a
    // silent off-by-1e10. Just verify we don't return the surprising 1.
    const out = clampInt("1e10", 50, 1, 200);
    expect(out).not.toBe(1);
    expect(out).toBeLessThanOrEqual(200);
  });

  test("float values truncate, not round (consistent integer semantics)", () => {
    expect(clampInt("3.7", 50, 1, 200)).toBe(3);
    expect(clampInt("3.2", 50, 1, 200)).toBe(3);
  });

  test("negative values clamp to min", () => {
    expect(clampInt("-5", 50, 1, 200)).toBe(1);
  });
});
