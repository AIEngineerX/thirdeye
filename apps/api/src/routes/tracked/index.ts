import { type DbClient, trackedWallets } from "@thirdeye/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { resyncWebhook, trackWallet } from "../../lib/track-wallet";

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

  await trackWallet(db, address, label, "manual");
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
