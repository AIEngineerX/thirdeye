import type { DbClient } from "@thirdeye/db";
import { HeliusError, type WalletCheckResult, checkWallet } from "@thirdeye/scanner";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { env } from "../../env";
import { sendSseEvent } from "../../lib/http";
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
  const userKey = c.req.header("X-User-Helius-Key");

  return streamSSE(c, async (stream) => {
    const db = c.get("db");
    const mode = userKey ? "byok" : "shared";

    if (!force) {
      const cached = await lookupRecentCheck(db, addr, env.WALLET_CHECK_CACHE_SEC);
      if (cached) {
        await sendSseEvent(stream, {
          event: "started",
          data: { addr, mode, cached: true },
        });
        await sendSseEvent(stream, { event: "result", data: cached });
        return;
      }
    }

    await publish({ event: "check:start", data: { address: addr } });

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
        await sendSseEvent(stream, evt);
        if (evt.event === "result") final = evt.data;
      }
    } catch (e) {
      // L3 (audit): only HeliusError messages are caller-safe (they're
      // already curated for client display). Other exceptions can carry
      // internal infrastructure detail — postgres hostnames, partial
      // dump of data structures from library asserts. Normalize to a
      // generic message; full error stays in the server log.
      const err =
        e instanceof HeliusError
          ? { error: "helius_error", message: e.message }
          : { error: "scanner_error", message: "internal error during scan" };
      console.error(`[scan ${addr}] ${err.error}`, e);
      await sendSseEvent(stream, { event: "error", data: err });
      return;
    }
    if (final) {
      try {
        await persistCheck(db, final);
        await publish({
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
