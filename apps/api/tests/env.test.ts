import { describe, expect, test } from "bun:test";
import { intStrict, validateCorsOrigin } from "../src/env";

describe("intStrict (env parsing)", () => {
  test("parses well-formed positive integer", () => {
    expect(intStrict("X", "42")).toBe(42);
  });

  test("parses negative integer", () => {
    expect(intStrict("X", "-7")).toBe(-7);
  });

  test("parses zero", () => {
    expect(intStrict("X", "0")).toBe(0);
  });

  test("trims surrounding whitespace", () => {
    expect(intStrict("X", "  42 ")).toBe(42);
  });

  test("throws on empty/whitespace-only input (was silent NaN)", () => {
    expect(() => intStrict("X", "")).toThrow(/X/);
    expect(() => intStrict("X", "   ")).toThrow(/X/);
  });

  test("throws on alpha suffix (was silent partial-parse)", () => {
    // Number("12345abc") returns NaN; parseInt("12345abc",10) returns 12345.
    // Both are surprising. Strict rejects.
    expect(() => intStrict("TG_ALLOWED_CHAT_ID", "12345abc")).toThrow(/12345abc/);
  });

  test("throws on scientific notation", () => {
    expect(() => intStrict("LIMIT", "1e10")).toThrow(/1e10/);
  });

  test("throws on float", () => {
    expect(() => intStrict("LIMIT", "12.5")).toThrow(/12\.5/);
  });

  test("throws on hex / binary literal", () => {
    expect(() => intStrict("LIMIT", "0xff")).toThrow();
    expect(() => intStrict("LIMIT", "0b101")).toThrow();
  });

  test("throws on out-of-range value", () => {
    expect(() => intStrict("LIMIT", "99999999999999999999")).toThrow(/range/);
  });
});

describe("validateCorsOrigin (M3)", () => {
  test("accepts a valid https origin with credentials", () => {
    expect(validateCorsOrigin("https://app.example.com", true)).toBe("https://app.example.com");
  });

  test("accepts http://localhost for dev", () => {
    expect(validateCorsOrigin("http://localhost:3000", true)).toBe("http://localhost:3000");
  });

  test("accepts comma-separated list of origins", () => {
    expect(validateCorsOrigin("https://a.example.com, https://b.example.com", true)).toBe(
      "https://a.example.com, https://b.example.com",
    );
  });

  test("rejects empty / whitespace", () => {
    expect(() => validateCorsOrigin("", true)).toThrow(/non-empty/);
    expect(() => validateCorsOrigin("   ", true)).toThrow(/non-empty/);
  });

  test("rejects '*' with credentials (browsers reject this combo)", () => {
    expect(() => validateCorsOrigin("*", true)).toThrow(/incompatible/i);
  });

  test("allows '*' when credentials are off", () => {
    expect(validateCorsOrigin("*", false)).toBe("*");
  });

  test("rejects wildcard subdomain syntax (literal match, no glob)", () => {
    expect(() => validateCorsOrigin("*.example.com", true)).toThrow(/wildcard/i);
  });

  test("rejects non-URL string", () => {
    expect(() => validateCorsOrigin("not-a-url", true)).toThrow();
  });

  test("rejects ftp:// scheme (must be http/https)", () => {
    expect(() => validateCorsOrigin("ftp://example.com", true)).toThrow();
  });
});
