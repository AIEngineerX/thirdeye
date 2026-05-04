import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy, respondError } from "./_lib";

export const batchIdentity = new Hono();

batchIdentity.post("/v1/wallet/batch-identity", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const addresses = (body as { addresses?: unknown })?.addresses;
  if (!Array.isArray(addresses)) {
    return respondError(c, ProxyError.invalidBody("expected { addresses: string[] }"));
  }
  if (addresses.length === 0 || addresses.length > 100) {
    return respondError(c, ProxyError.invalidBody("1..100 addresses required"));
  }
  for (const a of addresses) {
    if (typeof a !== "string" || !isValidSolanaAddress(a)) {
      return respondError(c, ProxyError.invalidAddress());
    }
  }
  return executeProxy(c, {
    target: { kind: "rest", path: "/v1/wallet/batch-identity" },
    method: "POST",
    body: { addresses },
    cacheTtlMs: TTL.DEFAULT,
  });
});
