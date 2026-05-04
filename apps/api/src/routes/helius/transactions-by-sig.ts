import { ProxyError, TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { executeProxy, respondError } from "./_lib";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export const transactionsBySig = new Hono();

transactionsBySig.post("/v0/transactions", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const txs = (body as { transactions?: unknown })?.transactions;
  if (!Array.isArray(txs)) {
    return respondError(c, ProxyError.invalidBody("expected { transactions: string[] }"));
  }
  if (txs.length === 0 || txs.length > 100) {
    return respondError(c, ProxyError.invalidBody("1..100 signatures required"));
  }
  for (const t of txs) {
    if (typeof t !== "string" || !SIG_RE.test(t)) {
      return respondError(
        c,
        ProxyError.invalidBody(`Invalid signature: ${typeof t === "string" ? t : "(non-string)"}`),
      );
    }
  }
  return executeProxy(c, {
    target: { kind: "rest", path: "/v0/transactions" },
    method: "POST",
    body: { transactions: txs },
    cacheTtlMs: TTL.IMMUTABLE,
  });
});
