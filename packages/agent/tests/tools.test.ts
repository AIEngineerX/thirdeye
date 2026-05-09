import { describe, expect, test } from "bun:test";
import { getToolByName, tools } from "../src/tools";

describe("tool registry", () => {
  test("registers exactly the Phase 6b tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "checkWallet",
        "scanToken",
        "getClusterSiblings",
        "getFunderClusters",
        "getHotTokens",
        "getWatchlist",
      ].sort(),
    );
  });

  test("every tool has description ≥20 chars + JSON Schema input", () => {
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema).toBeDefined();
      expect(t.input_schema.type).toBe("object");
      expect(Array.isArray(t.input_schema.required)).toBe(true);
    }
  });

  test("getToolByName returns the right tool", () => {
    expect(getToolByName("checkWallet")?.name).toBe("checkWallet");
    expect(getToolByName("nonexistent")).toBeUndefined();
  });

  test("checkWallet input schema requires address", () => {
    const ct = getToolByName("checkWallet");
    expect(ct?.input_schema.required).toContain("address");
  });

  test("scanToken input schema requires mint", () => {
    const st = getToolByName("scanToken");
    expect(st?.input_schema.required).toContain("mint");
  });

  test("paginated tools have optional limit (no required fields)", () => {
    expect(getToolByName("getFunderClusters")?.input_schema.required).toEqual([]);
    expect(getToolByName("getHotTokens")?.input_schema.required).toEqual([]);
    expect(getToolByName("getWatchlist")?.input_schema.required).toEqual([]);
  });
});
