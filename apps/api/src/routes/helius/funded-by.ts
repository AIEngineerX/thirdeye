import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy, respondError } from "./_lib";

export const fundedBy = new Hono();

fundedBy.get("/v1/wallet/:addr/funded-by", (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) return respondError(c, ProxyError.invalidAddress());
  return executeProxy(c, {
    target: { kind: "rest", path: `/v1/wallet/${addr}/funded-by` },
    method: "GET",
    cacheTtlMs: TTL.IMMUTABLE,
  });
});
