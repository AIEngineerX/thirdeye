import { describe, expect, test } from "bun:test";
import { generateToken, EXPIRES_IN_DAYS } from "../src/lib/tokens";

describe("generateToken", () => {
  test("returns a base64url string of length 43", () => {
    const { token } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("expiresAt is roughly now + 7 days", () => {
    const before = Date.now();
    const { expiresAt } = generateToken();
    const after = Date.now();

    const expectedMin = before + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = after + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000 + 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  test("two consecutive calls produce different tokens", () => {
    const a = generateToken().token;
    const b = generateToken().token;
    expect(a).not.toBe(b);
  });
});
