import { describe, expect, test } from "bun:test";
import { cache, composeCacheKey } from "@thirdeye/helius";

describe("composeCacheKey", () => {
  test("deterministic for identical input", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    const b = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    expect(a).toBe(b);
  });

  test("query param order does not affect key", () => {
    const a = composeCacheKey({
      method: "GET",
      path: "/v1/x",
      query: { a: "1", b: "2" },
    });
    const b = composeCacheKey({
      method: "GET",
      path: "/v1/x",
      query: { b: "2", a: "1" },
    });
    expect(a).toBe(b);
  });

  test("body order does not affect key (objects)", () => {
    const a = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { a: 1, b: 2 },
    });
    const b = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { b: 2, a: 1 },
    });
    expect(a).toBe(b);
  });

  test("nested body order does not affect key", () => {
    const a = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { outer: { a: 1, b: 2 } },
    });
    const b = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { outer: { b: 2, a: 1 } },
    });
    expect(a).toBe(b);
  });

  test("array order DOES affect key (preserves semantic ordering)", () => {
    const a = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { items: [1, 2, 3] },
    });
    const b = composeCacheKey({
      method: "POST",
      path: "/v1/x",
      body: { items: [3, 2, 1] },
    });
    expect(a).not.toBe(b);
  });

  test("differs across method", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x" });
    const b = composeCacheKey({ method: "POST", path: "/v1/x" });
    expect(a).not.toBe(b);
  });

  test("differs across path", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/a" });
    const b = composeCacheKey({ method: "GET", path: "/v1/b" });
    expect(a).not.toBe(b);
  });

  test("api-key is never in key (sha256 hex output, no leak)", () => {
    const a = composeCacheKey({ method: "GET", path: "/v1/x", query: { a: "1" } });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("api-key");
  });
});

describe("LRU cache instance", () => {
  test("get returns set value within TTL", () => {
    cache.clear();
    cache.set("k", { status: 200, body: { ok: true } }, { ttl: 1000 });
    expect(cache.get("k")).toEqual({ status: 200, body: { ok: true } });
  });

  test("returns undefined for unknown key", () => {
    cache.clear();
    expect(cache.get("missing")).toBeUndefined();
  });

  test("respects per-entry TTL", async () => {
    cache.clear();
    cache.set("short", { status: 200, body: 1 }, { ttl: 50 });
    cache.set("long", { status: 200, body: 2 }, { ttl: 60_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toEqual({ status: 200, body: 2 });
  });
});
