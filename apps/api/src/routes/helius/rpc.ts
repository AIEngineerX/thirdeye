import { Hono } from "hono";
import { rpcCacheTtlMs, validateRpcEnvelope } from "@thirdeye/helius";
import { executeProxy } from "./_lib";

export const rpc = new Hono();

rpc.post("/api/helius-rpc", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: "invalid_rpc_body", message: "body must be valid JSON" },
      400,
    );
  }
  const r = validateRpcEnvelope(body);
  if (r.kind === "invalid") {
    return c.json({ error: "invalid_rpc_body", message: r.reason }, 400);
  }
  if (r.kind === "forbidden") {
    return c.json(
      {
        error: "forbidden_rpc_method",
        message: `RPC method '${r.method}' is not allowed`,
      },
      403,
    );
  }
  return executeProxy(c, {
    target: {
      kind: "rpc",
      method: r.envelope.method,
      params: r.envelope.params,
    },
    method: "POST",
    cacheTtlMs: rpcCacheTtlMs(r.envelope.method),
  });
});
