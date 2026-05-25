import { type DbClient, trackedWallets } from "@thirdeye/db";
import { SolanaTrackerClient, SolanaTrackerError } from "@thirdeye/solanatracker";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { env, heliusWebhookAuth, publicBaseUrl } from "../../env";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { snapshotWalletQuality } from "../../lib/wallet-quality";
import { syncHeliusWebhook } from "../watches/sync";

type Variables = { db: DbClient };

export const trackedRoutes = new Hono<{ Variables: Variables }>();

interface AddBody {
  address?: unknown;
  label?: unknown;
}

trackedRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as AddBody | null;
  const address = body?.address;
  if (typeof address !== "string" || !isValidSolanaAddress(address)) {
    return c.json({ error: "invalid_address", message: "expected a base58 address" }, 400);
  }
  const label = typeof body?.label === "string" ? body.label : null;
  const db = c.get("db");

  // Best-effort ST quality snapshot — one call, only when configured. Never
  // fail the add if ST is down/rate-limited: the wallet still gets tracked.
  let quality: Awaited<ReturnType<typeof snapshotWalletQuality>> = null;
  if (env.SOLANATRACKER_API_KEY) {
    try {
      quality = await snapshotWalletQuality(
        new SolanaTrackerClient({ apiKey: env.SOLANATRACKER_API_KEY }),
        address,
      );
    } catch (e) {
      if (!(e instanceof SolanaTrackerError)) throw e;
      console.error(`[tracked.add ${address}] ST snapshot ${e.status}: ${e.message}`);
    }
  }

  await db
    .insert(trackedWallets)
    .values({
      address,
      label,
      source: "manual",
      winRate: quality?.winRate?.toString() ?? null,
      realizedPnlUsd: quality?.realizedPnlUsd?.toString() ?? null,
      roi: quality?.roi?.toString() ?? null,
      tokensTraded: quality?.tokensTraded ?? null,
      identity: quality?.identity ?? null,
      pnlSyncedAt: quality ? new Date() : null,
    })
    // Re-add updates label/source only; quality is owned by the snapshot-on-first-add
    // (and a future refresh path), so we don't clobber it here.
    .onConflictDoUpdate({ target: trackedWallets.address, set: { label, source: "manual" } });

  // Best-effort webhook resync. A resync failure does NOT roll back the DB
  // insert — the wallet IS tracked and Helius will catch up on the next
  // add/remove. This diverges from watches (which wraps insert+sync in a tx)
  // because tracked_wallets is global (not per-token); an orphaned DB row
  // that missed one webhook sync is far less harmful than a failed add where
  // the user believes the wallet is tracked but it wasn't persisted.
  await resyncWebhook(db);
  return c.json({ added: 1, address, label }, 200);
});

trackedRoutes.get("/", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(trackedWallets).orderBy(desc(trackedWallets.addedAt));
  return c.json({
    items: rows.map((r) => ({
      address: r.address,
      label: r.label,
      source: r.source,
      winRate: r.winRate === null ? null : Number(r.winRate),
      realizedPnlUsd: r.realizedPnlUsd === null ? null : Number(r.realizedPnlUsd),
      roi: r.roi === null ? null : Number(r.roi),
      tokensTraded: r.tokensTraded,
      addedAt: r.addedAt.toISOString(),
    })),
  });
});

trackedRoutes.delete("/:address", async (c) => {
  const address = c.req.param("address");
  if (!isValidSolanaAddress(address)) return c.json({ error: "invalid_address" }, 400);
  const db = c.get("db");
  await db.delete(trackedWallets).where(eq(trackedWallets.address, address));
  // Same best-effort resync pattern as POST.
  await resyncWebhook(db);
  return c.json({ removed: 1 });
});

// Re-sync the managed Helius webhook so the new/removed address set takes
// effect. Skips silently when the webhook env isn't fully configured (e.g.
// local dev without a public URL) — tracking still works, just no live events.
// Errors are logged and swallowed: the DB write has already committed, and the
// webhook will be corrected on the next add/remove operation.
async function resyncWebhook(db: DbClient): Promise<void> {
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
    console.error("[tracked] webhook resync failed", e);
    // Swallow — DB write already committed. Webhook corrects on next mutation.
  }
}
