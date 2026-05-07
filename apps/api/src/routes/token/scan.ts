import type { DbClient } from "@thirdeye/db";
import { HeliusError, type TokenScanResult, scanToken } from "@thirdeye/scanner";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { env } from "../../env";
import { sendSseEvent } from "../../lib/http";
import { publish } from "../../lib/intel-bus";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { lookupRecentScan, persistScan, resolvePriorTags } from "./persist";

type Variables = { db: DbClient };

export const tokenScan = new Hono<{ Variables: Variables }>();

tokenScan.get("/:mint/scan", async (c) => {
  const mint = c.req.param("mint");
  if (!isValidSolanaAddress(mint)) {
    return c.json({ error: "invalid_mint", message: "Mint is not a valid base58 address" }, 400);
  }
  const force = c.req.query("force") === "true";
  const userKey = c.req.header("X-User-Helius-Key") ?? undefined;

  return streamSSE(c, async (stream) => {
    const db = c.get("db");
    const mode = userKey ? "byok" : "shared";

    if (!force) {
      const cached = await lookupRecentScan(db, mint, env.SCAN_TOKEN_CACHE_SEC);
      if (cached) {
        await sendSseEvent(stream, {
          event: "started",
          data: { mint, mode, cached: true },
        });
        await sendSseEvent(stream, { event: "result", data: cached });
        return;
      }
    }

    await publish({ event: "scan:start", data: { mint, symbol: null } });

    const generator = scanToken({
      mint,
      serverKey: env.HELIUS_API_KEY,
      ...(userKey !== undefined && { userKey }),
      resolvePriorTags: (addrs) => resolvePriorTags(db, addrs),
    });

    let final: TokenScanResult | null = null;
    try {
      for await (const evt of generator) {
        await sendSseEvent(stream, evt);
        if (evt.event === "result") final = evt.data;
      }
    } catch (e) {
      const err =
        e instanceof HeliusError
          ? { error: "helius_error", message: e.message }
          : { error: "scanner_error", message: e instanceof Error ? e.message : String(e) };
      console.error(`[scan-token ${mint}] ${err.error}: ${err.message}`, e);
      await sendSseEvent(stream, { event: "error", data: err });
      return;
    }
    if (final) {
      try {
        await persistScan(db, final);
        await publish({
          event: "scan:complete",
          data: {
            id: null,
            mint: final.mint,
            symbol: final.metadata.symbol,
            risk: final.risk,
            sybilFlag: final.sybilFlag,
          },
        });
      } catch (e) {
        console.error(`[persist-scan ${mint}]`, e);
      }
    }
  });
});

tokenScan.get("/:mint/scans/latest", async (c) => {
  const mint = c.req.param("mint");
  if (!isValidSolanaAddress(mint)) {
    return c.json({ error: "invalid_mint", message: "Mint is not a valid base58 address" }, 400);
  }
  const cached = await lookupRecentScan(c.get("db"), mint, env.SCAN_TOKEN_CACHE_SEC);
  if (!cached) return c.json({ error: "not_found", message: "No recent scan" }, 404);
  return c.json(cached);
});
