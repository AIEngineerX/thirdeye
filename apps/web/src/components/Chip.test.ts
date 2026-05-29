import { describe, expect, test } from "bun:test";
import { chipToneClasses } from "./Chip";

describe("chipToneClasses", () => {
  test("maps tones to zero-radius severity classes (mirrors TagList)", () => {
    expect(chipToneClasses("mint")).toBe("border text-clean border-clean/60 bg-clean/10");
    expect(chipToneClasses("crimson")).toBe("border text-high border-high/60 bg-high/10");
    expect(chipToneClasses("amber")).toBe("border text-med border-med/60 bg-med/10");
    expect(chipToneClasses("slate")).toBe("border text-secondary border-border-emphasis bg-card");
  });
  test("no rounded class", () => {
    for (const t of ["mint", "amber", "crimson", "slate"] as const) {
      expect(chipToneClasses(t)).not.toContain("rounded");
    }
  });
});
