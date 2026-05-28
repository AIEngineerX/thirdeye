import { describe, expect, test } from "bun:test";
import { computeOutcome } from "../src/signal-math";

describe("computeOutcome", () => {
  test("new peak raises ath and multiplier off call_mc", () => {
    const r = computeOutcome({
      callMc: 75_000,
      safeCallMc: 97_000,
      currentMc: 277_000,
      priorAthMc: 159_000,
      hitMultiplier: 2,
    });
    expect(r.athMc).toBe(277_000);
    expect(r.newPeak).toBe(true);
    expect(r.athMultiplier).toBeCloseTo(277_000 / 75_000, 5);
    expect(r.safeAthMultiplier).toBeCloseTo(277_000 / 97_000, 5);
    expect(r.isHit).toBe(true); // 3.69x >= 2
    expect(r.safeIsHit).toBe(true); // 2.85x >= 2
  });

  test("current below prior ath does not lower ath and is not a new peak", () => {
    const r = computeOutcome({
      callMc: 50_000,
      safeCallMc: 60_000,
      currentMc: 80_000,
      priorAthMc: 120_000,
      hitMultiplier: 2,
    });
    expect(r.athMc).toBe(120_000);
    expect(r.newPeak).toBe(false);
    expect(r.athMultiplier).toBeCloseTo(120_000 / 50_000, 5); // 2.4x
    expect(r.isHit).toBe(true);
  });

  test("safe hit is stricter than raw hit when safe base is higher", () => {
    const r = computeOutcome({
      callMc: 50_000,
      safeCallMc: 90_000,
      currentMc: 120_000,
      priorAthMc: null,
      hitMultiplier: 2,
    });
    expect(r.athMultiplier).toBeCloseTo(2.4, 5); // hit
    expect(r.isHit).toBe(true);
    expect(r.safeAthMultiplier).toBeCloseTo(120_000 / 90_000, 5); // 1.33x
    expect(r.safeIsHit).toBe(false);
  });

  test("null call_mc yields null multipliers and no hit (never optimistic)", () => {
    const r = computeOutcome({
      callMc: null,
      safeCallMc: null,
      currentMc: 100_000,
      priorAthMc: null,
      hitMultiplier: 2,
    });
    expect(r.athMc).toBe(100_000);
    expect(r.athMultiplier).toBeNull();
    expect(r.safeAthMultiplier).toBeNull();
    expect(r.isHit).toBe(false);
    expect(r.safeIsHit).toBe(false);
  });
});
