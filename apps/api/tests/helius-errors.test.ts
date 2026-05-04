import { describe, expect, test } from "bun:test";
import { ProxyError, mapUpstreamStatus } from "@thirdeye/helius";

describe("mapUpstreamStatus", () => {
  test("2xx returns null (no error)", () => {
    expect(mapUpstreamStatus(200)).toBeNull();
    expect(mapUpstreamStatus(204)).toBeNull();
  });

  test("4xx is passthrough", () => {
    const e = mapUpstreamStatus(404)!;
    expect(e.status).toBe(404);
    expect(e.error).toBe("upstream_404");
    expect(e.upstreamStatus).toBe(404);
  });

  test("429 keeps 429 status with upstream_429 code", () => {
    const e = mapUpstreamStatus(429)!;
    expect(e.status).toBe(429);
    expect(e.error).toBe("upstream_429");
  });

  test("5xx becomes ThirdEye 502", () => {
    const e = mapUpstreamStatus(500)!;
    expect(e.status).toBe(502);
    expect(e.error).toBe("upstream_error");
    expect(e.upstreamStatus).toBe(500);

    const e2 = mapUpstreamStatus(503)!;
    expect(e2.status).toBe(502);
    expect(e2.upstreamStatus).toBe(503);
  });
});

describe("ProxyError helpers", () => {
  test("timeout helper produces 504", () => {
    expect(ProxyError.timeout().status).toBe(504);
    expect(ProxyError.timeout().error).toBe("upstream_timeout");
  });

  test("noKey helper produces 503", () => {
    expect(ProxyError.noKey().status).toBe(503);
    expect(ProxyError.noKey().error).toBe("no_helius_key");
  });

  test("invalidAddress produces 400", () => {
    expect(ProxyError.invalidAddress().status).toBe(400);
  });

  test("forbiddenRpcMethod includes method name", () => {
    expect(ProxyError.forbiddenRpcMethod("sendTransaction").status).toBe(403);
    expect(ProxyError.forbiddenRpcMethod("sendTransaction").message).toContain("sendTransaction");
  });

  test("rateLimited carries retryAfterSec", () => {
    const e = ProxyError.rateLimited(42);
    expect(e.status).toBe(429);
    expect(e.retryAfterSec).toBe(42);
  });
});
