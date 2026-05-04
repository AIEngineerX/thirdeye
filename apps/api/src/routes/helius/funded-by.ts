import { Hono } from "hono";
import { TTL, ProxyError } from "@thirdeye/helius";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy } from "./_lib";

export const fundedBy = new Hono();

fundedBy.get("/v1/wallet/:addr/funded-by", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    const err = ProxyError.invalidAddress();
    return c.json({ error: err.error, message: err.message }, 400);
  }
  return executeProxy(c, {
    target: { kind: "rest", path: `/v1/wallet/${addr}/funded-by` },
    method: "GET",
    cacheTtlMs: TTL.IMMUTABLE,
  });
});
