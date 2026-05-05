import { ProxyError, rpcCacheTtlMs, validateRpcEnvelope } from "@thirdeye/helius";
import { Hono } from "hono";
import { executeProxy, respondError } from "./_lib";

export const rpc = new Hono();

rpc.post("/api/helius-rpc", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (body === null) return respondError(c, ProxyError.invalidRpcBody("body must be valid JSON"));

  const r = validateRpcEnvelope(body);
  if (r.kind === "invalid") return respondError(c, ProxyError.invalidRpcBody(r.reason));
  if (r.kind === "forbidden") return respondError(c, ProxyError.forbiddenRpcMethod(r.method));

  return executeProxy(c, {
    target: { kind: "rpc", method: r.method, params: r.params },
    method: "POST",
    cacheTtlMs: rpcCacheTtlMs(r.method),
  });
});
