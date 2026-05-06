import { type DbClient, wallets } from "@thirdeye/db";
import { HeliusError, type WalletCheckResult, checkWallet } from "@thirdeye/scanner";
import { sql } from "drizzle-orm";
import { persistCheck, resolveSiblings } from "../routes/wallet/persist";

const BATCH_SIZE = 100;

export interface EnrichOptions {
  serverKey: string | undefined;
}

// Hourly cron — re-check the 100 oldest tagged wallets where last_checked
// is > 7 days old. Skips never-tagged wallets to save Helius credits.
// Errors per-wallet are logged and the loop continues; one bad wallet does
// not abort the batch.
export async function enrichWallet(
  db: DbClient,
  opts: EnrichOptions,
): Promise<{ scanned: number; errored: number }> {
  if (!opts.serverKey) {
    console.warn("[enrich-wallet] HELIUS_API_KEY unset — skipping batch");
    return { scanned: 0, errored: 0 };
  }

  const candidates = await db
    .select({ address: wallets.address })
    .from(wallets)
    .where(
      sql`${wallets.lastChecked} < now() - interval '7 days' AND array_length(${wallets.tags}, 1) > 0`,
    )
    .orderBy(sql`${wallets.lastChecked} ASC NULLS FIRST`)
    .limit(BATCH_SIZE);

  let errored = 0;
  for (const { address } of candidates) {
    try {
      const generator = checkWallet({
        address,
        serverKey: opts.serverKey,
        resolveSiblings: (funder, limit) => resolveSiblings(db, funder, limit),
      });
      let final: WalletCheckResult | null = null;
      for await (const evt of generator) {
        if (evt.event === "result") final = evt.data;
      }
      if (final) await persistCheck(db, final);
    } catch (e) {
      errored++;
      const msg = e instanceof HeliusError ? e.message : String(e);
      console.error(`[enrich-wallet ${address}] ${msg}`);
    }
  }

  return { scanned: candidates.length, errored };
}
