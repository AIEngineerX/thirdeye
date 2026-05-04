import { Hono } from "hono";
import { TTL } from "@thirdeye/helius";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { executeProxy } from "./_lib";

export const batchIdentity = new Hono();

batchIdentity.post("/v1/wallet/batch-identity", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { addresses?: unknown }).addresses)
  ) {
    return c.json(
      { error: "invalid_body", message: "expected { addresses: string[] }" },
      400,
    );
  }
  const addresses = (body as { addresses: unknown[] }).addresses;
  if (addresses.length === 0 || addresses.length > 100) {
    return c.json(
      { error: "invalid_body", message: "1..100 addresses required" },
      400,
    );
  }
  for (const a of addresses) {
    if (typeof a !== "string" || !isValidSolanaAddress(a)) {
      return c.json(
        { error: "invalid_address", message: `Invalid address: ${String(a)}` },
        400,
      );
    }
  }
  return executeProxy(c, {
    target: { kind: "rest", path: "/v1/wallet/batch-identity" },
    method: "POST",
    body: { addresses },
    cacheTtlMs: TTL.DEFAULT,
  });
});
