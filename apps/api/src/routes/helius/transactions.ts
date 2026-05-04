import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy, pickQuery, respondError } from "./_lib";

const ALLOWED_QUERY_KEYS = ["limit", "before", "until", "commitment", "type", "source"] as const;

export const transactions = new Hono();

transactions.get("/v0/addresses/:addr/transactions", (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) return respondError(c, ProxyError.invalidAddress());
  return executeProxy(c, {
    target: {
      kind: "rest",
      path: `/v0/addresses/${addr}/transactions`,
      query: pickQuery(c, ALLOWED_QUERY_KEYS),
    },
    method: "GET",
    cacheTtlMs: TTL.DEFAULT,
  });
});
