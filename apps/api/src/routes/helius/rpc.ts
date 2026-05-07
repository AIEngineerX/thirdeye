import { ProxyError, rpcCacheTtlMs, validateRpcEnvelope } from "@thirdeye/helius";
import { Hono } from "hono";
import { executeProxy, respondError } from "./_lib";

export const rpc = new Hono();

// Path is "/" because the parent mounts this router at "/api/helius-rpc".
// Mounting the wrapper at "/" with `use("*", requireAuth)` previously
// leaked the auth middleware to every other route — fixed by binding to
// the specific prefix.
rpc.post("/", async (c) => {
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
