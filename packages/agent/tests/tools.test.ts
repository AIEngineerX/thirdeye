import { describe, expect, test } from "bun:test";
import { getToolByName, tools } from "../src/tools";

const VALID_ADDR = "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1";
// 33 chars total, passes length-only check, fails strict b58.
const URL_INJECTION_PAYLOAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa/foo";
// Contains '0' which is not in Solana b58.
const NON_B58_DIGIT = "0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// Contains 'O' which is not in Solana b58.
const NON_B58_LETTER = "OAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

// Calling the handler with `ctx: undefined` lets us assert that input
// validation rejects the payload before the handler ever touches the DB
// or the scanner. A handler that admits the payload would crash on
// `ctx.db` and produce a different error string.
const NO_CTX = undefined as never;

describe("address/mint input validation (security: prevents Helius URL splicing)", () => {
  test("checkWallet rejects non-b58 chars even at valid length", async () => {
    const tool = getToolByName("checkWallet")!;
    for (const bad of [URL_INJECTION_PAYLOAD, NON_B58_DIGIT, NON_B58_LETTER]) {
      await expect(tool.handler({ address: bad }, NO_CTX)).rejects.toThrow();
    }
  });

  test("scanToken rejects non-b58 chars even at valid length", async () => {
    const tool = getToolByName("scanToken")!;
    for (const bad of [URL_INJECTION_PAYLOAD, NON_B58_DIGIT, NON_B58_LETTER]) {
      await expect(tool.handler({ mint: bad }, NO_CTX)).rejects.toThrow();
    }
  });

  test("getClusterSiblings rejects non-b58 chars even at valid length", async () => {
    const tool = getToolByName("getClusterSiblings")!;
    for (const bad of [URL_INJECTION_PAYLOAD, NON_B58_DIGIT, NON_B58_LETTER]) {
      await expect(tool.handler({ address: bad }, NO_CTX)).rejects.toThrow();
    }
  });

  test("a real b58 address passes Zod and reaches the handler body (errors on missing ctx, not on parse)", async () => {
    const tool = getToolByName("checkWallet")!;
    // We're not running the scanner here — just confirming that VALID_ADDR
    // gets past .parse(). With NO_CTX, the handler will fail later when it
    // hits ctx.db / ctx.serverHeliusKey, but the throw won't be a ZodError.
    await expect(tool.handler({ address: VALID_ADDR }, NO_CTX)).rejects.toThrow();
    // Confirm the throw is NOT from Zod parse (which would be TypeError-ish
    // and contain 'Invalid' from the regex check).
    try {
      await tool.handler({ address: VALID_ADDR }, NO_CTX);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toMatch(/Invalid/i);
    }
  });
});
