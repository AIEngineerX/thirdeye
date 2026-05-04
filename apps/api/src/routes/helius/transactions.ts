import { Hono } from "hono";
import { TTL, ProxyError } from "@thirdeye/helius";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy } from "./_lib";

const ALLOWED_QUERY_KEYS = [
  "limit",
  "before",
  "until",
  "commitment",
  "type",
  "source",
] as const;

export const transactions = new Hono();

transactions.get("/v0/addresses/:addr/transactions", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    const err = ProxyError.invalidAddress();
    return c.json({ error: err.error, message: err.message }, 400);
  }
  const query: Record<string, string> = {};
  for (const k of ALLOWED_QUERY_KEYS) {
    const v = c.req.query(k);
    if (v !== undefined) query[k] = v;
  }
  return executeProxy(c, {
    target: {
      kind: "rest",
      path: `/v0/addresses/${addr}/transactions`,
      ...(Object.keys(query).length > 0 && { query }),
    },
    method: "GET",
    cacheTtlMs: TTL.DEFAULT,
  });
});
