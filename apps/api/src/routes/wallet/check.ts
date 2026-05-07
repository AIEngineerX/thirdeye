import type { DbClient } from "@thirdeye/db";
import {
  type CheckEvent,
  HeliusError,
  type WalletCheckResult,
  checkWallet,
} from "@thirdeye/scanner";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { env } from "../../env";
import { publish } from "../../lib/intel-bus";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { lookupRecentCheck, persistCheck, resolveSiblings } from "./persist";

type Variables = { db: DbClient };

export const walletCheck = new Hono<{ Variables: Variables }>();

walletCheck.get("/:addr/check", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    return c.json({ error: "invalid_address", message: "Address is not valid base58" }, 400);
  }
  const force = c.req.query("force") === "true";
  const userKey = c.req.header("X-User-Helius-Key") ?? undefined;

  return streamSSE(c, async (stream) => {
    const db = c.get("db");
    const mode = userKey ? "byok" : "shared";

    if (!force) {
      const cached = await lookupRecentCheck(db, addr, env.WALLET_CHECK_CACHE_SEC);
      if (cached) {
        await sendEvent(stream, {
          event: "started",
          data: { addr, mode, cached: true },
        });
        await sendEvent(stream, { event: "result", data: cached });
        return;
      }
    }

    void publish({ event: "check:start", data: { address: addr } });

    const generator = checkWallet({
      address: addr,
      serverKey: env.HELIUS_API_KEY,
      ...(userKey !== undefined && { userKey }),
      resolveSiblings: (funder, limit) => resolveSiblings(db, funder, limit),
      smartMoneyMinSol: env.SMART_MONEY_MIN_SOL,
    });

    let final: WalletCheckResult | null = null;
    try {
      for await (const evt of generator) {
        await sendEvent(stream, evt);
        if (evt.event === "result") final = evt.data;
      }
    } catch (e) {
      const err =
        e instanceof HeliusError
          ? { error: "helius_error", message: e.message }
          : { error: "scanner_error", message: e instanceof Error ? e.message : String(e) };
      console.error(`[scan ${addr}] ${err.error}: ${err.message}`, e);
      await sendEvent(stream, { event: "error", data: err });
      return;
    }
    if (final) {
      try {
        await persistCheck(db, final);
        void publish({
          event: "check:complete",
          data: { address: final.address, score: final.score, verdict: final.verdict },
        });
      } catch (e) {
        console.error(`[persist ${addr}]`, e);
      }
    }
  });
});

walletCheck.get("/:addr/last-check", async (c) => {
  const addr = c.req.param("addr");
  if (!isValidSolanaAddress(addr)) {
    return c.json({ error: "invalid_address", message: "Address is not valid base58" }, 400);
  }
  const cached = await lookupRecentCheck(c.get("db"), addr, env.WALLET_CHECK_CACHE_SEC);
  if (!cached) return c.json({ error: "not_found", message: "No recent check" }, 404);
  return c.json(cached);
});

async function sendEvent(stream: SSEStreamingApi, evt: CheckEvent): Promise<void> {
  await stream.writeSSE({ event: evt.event, data: JSON.stringify(evt.data) });
}
