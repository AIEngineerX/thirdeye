import { TTL } from "@thirdeye/helius";
import { Hono } from "hono";
import { executeProxy } from "./_lib";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export const transactionsBySig = new Hono();

transactionsBySig.post("/v0/transactions", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { transactions?: unknown }).transactions)
  ) {
    return c.json({ error: "invalid_body", message: "expected { transactions: string[] }" }, 400);
  }
  const txs = (body as { transactions: unknown[] }).transactions;
  if (txs.length === 0 || txs.length > 100) {
    return c.json({ error: "invalid_body", message: "1..100 signatures required" }, 400);
  }
  for (const t of txs) {
    if (typeof t !== "string" || !SIG_RE.test(t)) {
      return c.json(
        {
          error: "invalid_signature",
          message: `Invalid signature: ${String(t)}`,
        },
        400,
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
