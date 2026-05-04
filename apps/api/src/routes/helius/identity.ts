import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy } from "./_lib";

export const identity = new Hono();

identity.get("/v1/wallet/:addr/identity", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    const err = ProxyError.invalidAddress();
    return c.json({ error: err.error, message: err.message }, 400);
  }
  return executeProxy(c, {
    target: { kind: "rest", path: `/v1/wallet/${addr}/identity` },
    method: "GET",
    cacheTtlMs: TTL.DEFAULT,
  });
});
