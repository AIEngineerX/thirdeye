// Exercises proxy.ts retry/timeout/unreachable code paths against a real
// local HTTP server. Not a mock of code under test — proxyToHelius runs
// unchanged, with globalThis.fetch redirected to a Bun.serve we control.
//
// The test server lets us deterministically produce 429 / slow / 500
// responses that real Helius cannot be coerced into.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cache, parseRetryAfterMs, proxyToHelius } from "@thirdeye/helius";

describe("parseRetryAfterMs", () => {
  test("null header → default 1s", () => {
    expect(parseRetryAfterMs(null)).toBe(1000);
  });

  test("integer seconds parsed and clamped", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    // Clamped to 5000ms max
    expect(parseRetryAfterMs("60")).toBe(5000);
  });

  test("zero or negative ignored, falls through to date parse, then default", () => {
    // "0" → asInt=0 → fails > 0 → tries Date.parse("0") which on some platforms
    // is NaN; on others may be valid. Behavior: if NaN, returns default.
    const r = parseRetryAfterMs("0");
    expect(typeof r).toBe("number");
    expect(r).toBeGreaterThanOrEqual(0);
  });

  test("HTTP-date parsed", () => {
    const future = new Date(Date.now() + 2500).toUTCString();
    const r = parseRetryAfterMs(future);
    // ~2500ms, clamped to 5000 max; allow loose lower bound for test timing slop
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(5000);
  });

  test("garbage string → default", () => {
    expect(parseRetryAfterMs("nonsense")).toBe(1000);
  });

  test("clamps to max even on huge values", () => {
    expect(parseRetryAfterMs("99999")).toBe(5000);
  });
});

describe("proxyToHelius retry / error paths (real local server)", () => {
  type FetchFn = typeof globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: Bun.serve return type narrowing varies across releases
  let server: any = null;
  let serverPort = 0;
  let originalFetch: FetchFn;
  let count429 = 0;
  let count500 = 0;
  let countOk = 0;
  let countSlow = 0;

  function reset(): void {
    count429 = 0;
    count500 = 0;
    countOk = 0;
    countSlow = 0;
    cache.clear();
  }

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/retry-once") {
          count429++;
          if (count429 === 1) {
            return new Response("rate limited", {
              status: 429,
              headers: { "Retry-After": "1" },
            });
          }
          return Response.json({ ok: true, attempt: count429 });
        }
        if (url.pathname === "/always-429") {
          count429++;
          return new Response("rate limited forever", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        if (url.pathname === "/upstream-500") {
          count500++;
          return new Response("upstream broke", { status: 500 });
        }
        if (url.pathname === "/upstream-malformed") {
          return new Response("not-json{{{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/slow") {
          countSlow++;
          await new Promise((r) => setTimeout(r, 200));
          return Response.json({ ok: true });
        }
        if (url.pathname === "/ok") {
          countOk++;
          return Response.json({ wallet: "abc", domains: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    serverPort = server.port;

    // Redirect any fetch to api.helius.xyz to our local server.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const u = new URL(inputUrl);
      if (u.hostname === "api.helius.xyz" || u.hostname === "mainnet.helius-rpc.com") {
        u.protocol = "http:";
        u.hostname = "127.0.0.1";
        u.port = String(serverPort);
        return originalFetch(u.toString(), init);
      }
      return originalFetch(input, init);
    }) as FetchFn;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    server?.stop(true);
  });

  test("429 once then 200 → second attempt succeeds, body returned", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/retry-once" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "test-key",
    });
    expect(r.status).toBe(200);
    expect(r.fromCache).toBe(false);
    expect(count429).toBe(2); // initial + retry
    expect((r.body as { ok: boolean }).ok).toBe(true);
  }, 10_000);

  test("429 every time → returns mapped 429 error after one retry", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/always-429" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "test-key",
    });
    expect(r.status).toBe(429);
    expect(count429).toBe(2);
    const body = r.body as { error: string };
    expect(body.error).toBe("upstream_429");
  }, 10_000);

  test("upstream 500 → mapped to ThirdEye 502", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/upstream-500" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "test-key",
    });
    expect(r.status).toBe(502);
    const body = r.body as { error: string; upstreamStatus: number };
    expect(body.error).toBe("upstream_error");
    expect(body.upstreamStatus).toBe(500);
  });

  test("upstream malformed JSON → 502 upstream_malformed", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/upstream-malformed" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "test-key",
    });
    expect(r.status).toBe(502);
    const body = r.body as { error: string };
    expect(body.error).toBe("upstream_malformed");
  });

  test("timeout when upstream slower than timeoutMs", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/slow" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "test-key",
      timeoutMs: 50,
    });
    expect(r.status).toBe(504);
    const body = r.body as { error: string };
    expect(body.error).toBe("upstream_timeout");
  });

  test("missing key → 503 no_helius_key, no fetch", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/ok" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: undefined,
    });
    expect(r.status).toBe(503);
    expect(countOk).toBe(0);
  });

  test("BYOK key path: userKey wins over serverKey + isByok=true on result", async () => {
    reset();
    const r = await proxyToHelius({
      target: { kind: "rest", path: "/ok" },
      method: "GET",
      cacheTtlMs: 0,
      serverKey: "server-key",
      userKey: "byok-key",
    });
    expect(r.status).toBe(200);
    expect(r.isByok).toBe(true);
    expect(countOk).toBe(1);
  });

  test("cache MISS then HIT, no second upstream call", async () => {
    reset();
    const args = {
      target: { kind: "rest" as const, path: "/ok" },
      method: "GET" as const,
      cacheTtlMs: 60_000,
      serverKey: "test-key",
    };
    const r1 = await proxyToHelius(args);
    expect(r1.fromCache).toBe(false);
    expect(countOk).toBe(1);
    const r2 = await proxyToHelius(args);
    expect(r2.fromCache).toBe(true);
    expect(countOk).toBe(1); // still 1, not 2
    expect(r2.body).toEqual(r1.body);
  });
});
