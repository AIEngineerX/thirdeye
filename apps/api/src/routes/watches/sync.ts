// Phase 5e: keep our single managed Helius webhook in sync with the union
// of distinct addresses across all `watches` rows. Called whenever a
// watch is added or removed.
//
// State machine:
//   - No row in helius_webhooks → first sync creates the webhook upstream.
//   - Row exists, getWebhook returns null (deleted in dashboard) → recreate.
//   - Row exists, webhook present → updateWebhook with current address set.
//   - Address set is empty → delete the upstream webhook + clear the row.
//
// All errors are logged and re-thrown so the caller (route handler) can
// roll back the local DB write if Helius rejects.

import { type DbExecutor, heliusWebhooks, watches } from "@thirdeye/db";
import { createWebhook, deleteWebhook, getWebhook, updateWebhook } from "@thirdeye/helius";
import { eq, sql } from "drizzle-orm";

export interface SyncOptions {
  apiKey: string;
  webhookURL: string;
  authHeader: string;
}

// Accepts either the top-level DbClient or a transaction handle so callers
// can run sync inside a tx for atomic rollback of accompanying writes.
export async function syncHeliusWebhook(db: DbExecutor, opts: SyncOptions): Promise<void> {
  const distinct = await db.execute<{ address: string }>(sql`
    SELECT DISTINCT address FROM watches ORDER BY address
  `);
  const addresses = (distinct as unknown as { address: string }[]).map((r) => r.address);

  const existing = await db.select().from(heliusWebhooks).where(eq(heliusWebhooks.id, 1));
  const row = existing[0] ?? null;

  // Empty set: tear down the webhook entirely.
  if (addresses.length === 0) {
    if (row) {
      try {
        await deleteWebhook(opts.apiKey, row.webhookId);
      } catch (e) {
        console.error("[helius-webhook-sync] delete failed", e);
        // Continue — local row still gets cleared so we don't loop on a
        // dead webhook ID. Operator can prune via dashboard if needed.
      }
      await db.delete(heliusWebhooks).where(eq(heliusWebhooks.id, 1));
    }
    return;
  }

  if (row) {
    // Verify upstream still exists; recreate if it was deleted in dashboard.
    const upstream = await getWebhook(opts.apiKey, row.webhookId);
    if (upstream === null) {
      console.warn(`[helius-webhook-sync] stored webhook ${row.webhookId} is gone — recreating`);
      const created = await createWebhook({
        apiKey: opts.apiKey,
        webhookURL: opts.webhookURL,
        accountAddresses: addresses,
        authHeader: opts.authHeader,
      });
      await db
        .update(heliusWebhooks)
        .set({
          webhookId: created.webhookID,
          lastSyncedAt: sql`now()`,
          lastSyncedAddressCount: addresses.length,
        })
        .where(eq(heliusWebhooks.id, 1));
      return;
    }
    await updateWebhook({
      apiKey: opts.apiKey,
      webhookID: row.webhookId,
      accountAddresses: addresses,
    });
    await db
      .update(heliusWebhooks)
      .set({
        lastSyncedAt: sql`now()`,
        lastSyncedAddressCount: addresses.length,
      })
      .where(eq(heliusWebhooks.id, 1));
    return;
  }

  // No prior webhook — first sync.
  const created = await createWebhook({
    apiKey: opts.apiKey,
    webhookURL: opts.webhookURL,
    accountAddresses: addresses,
    authHeader: opts.authHeader,
  });
  await db.insert(heliusWebhooks).values({
    id: 1,
    webhookId: created.webhookID,
    lastSyncedAddressCount: addresses.length,
  });
}
