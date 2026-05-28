import { type DbClient, trackedWallets } from "@thirdeye/db";
import { SolanaTrackerClient, SolanaTrackerError } from "@thirdeye/solanatracker";
import { env, heliusWebhookAuth, publicBaseUrl } from "../env";
import { syncHeliusWebhook } from "../routes/watches/sync";
import { snapshotWalletQuality } from "./wallet-quality";

// Track a wallet: best-effort ST quality snapshot + upsert tracked_wallets +
// webhook resync. Shared by POST /tracked and candidate promotion.
export async function trackWallet(
  db: DbClient,
  address: string,
  label: string | null,
  source: string,
): Promise<void> {
  let quality: Awaited<ReturnType<typeof snapshotWalletQuality>> = null;
  if (env.SOLANATRACKER_API_KEY) {
    try {
      quality = await snapshotWalletQuality(
        new SolanaTrackerClient({ apiKey: env.SOLANATRACKER_API_KEY }),
        address,
      );
    } catch (e) {
      if (!(e instanceof SolanaTrackerError)) throw e;
      console.error(`[track ${address}] ST snapshot ${e.status}: ${e.message}`);
    }
  }
  await db
    .insert(trackedWallets)
    .values({
      address,
      label,
      source,
      winRate: quality?.winRate?.toString() ?? null,
      realizedPnlUsd: quality?.realizedPnlUsd?.toString() ?? null,
      roi: quality?.roi?.toString() ?? null,
      tokensTraded: quality?.tokensTraded ?? null,
      identity: quality?.identity ?? null,
      pnlSyncedAt: quality ? new Date() : null,
    })
    .onConflictDoUpdate({ target: trackedWallets.address, set: { label, source } });
  await resyncWebhook(db);
}

// Re-sync the managed Helius webhook so the new/removed address set takes
// effect. No-op when webhook env isn't configured. Errors logged, not thrown:
// the DB write already committed; the webhook self-corrects on next mutation.
export async function resyncWebhook(db: DbClient): Promise<void> {
  const baseUrl = publicBaseUrl();
  const webhookAuth = heliusWebhookAuth();
  if (!env.HELIUS_API_KEY || !baseUrl || !webhookAuth) return;
  try {
    await syncHeliusWebhook(db, {
      apiKey: env.HELIUS_API_KEY,
      webhookURL: `${baseUrl.replace(/\/$/, "")}/api/helius-webhook`,
      authHeader: webhookAuth,
    });
  } catch (e) {
    console.error("[track] webhook resync failed", e);
  }
}
