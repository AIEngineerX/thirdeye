import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy, pickQuery, respondError } from "./_lib";

const ALLOWED_QUERY_KEYS = ["limit", "showNative"] as const;

export const balances = new Hono();

balances.get("/v1/wallet/:addr/balances", (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) return respondError(c, ProxyError.invalidAddress());
  return executeProxy(c, {
    target: {
      kind: "rest",
      path: `/v1/wallet/${addr}/balances`,
      query: pickQuery(c, ALLOWED_QUERY_KEYS),
    },
    method: "GET",
    cacheTtlMs: TTL.DEFAULT,
  });
});
