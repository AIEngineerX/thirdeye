import { type DbClient, candidateWallets } from "@thirdeye/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../../lib/solana-address";
import { trackWallet } from "../../lib/track-wallet";
import { listCandidates } from "../../lib/wallet-universe";

type Variables = { db: DbClient };
export const candidatesRoutes = new Hono<{ Variables: Variables }>();

candidatesRoutes.get("/", async (c) => {
  const db = c.get("db");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const includePromoted = c.req.query("includePromoted") === "true";
  const sourceParam = c.req.query("source");
  const opts: Parameters<typeof listCandidates>[1] = { limit, includePromoted };
  if (sourceParam !== undefined) opts.source = sourceParam;
  const items = await listCandidates(db, opts);
  return c.json({ items });
});

candidatesRoutes.post("/:address/promote", async (c) => {
  const address = c.req.param("address");
  if (!isValidSolanaAddress(address)) return c.json({ error: "invalid_address" }, 400);
  const db = c.get("db");
  const rows = await db
    .select()
    .from(candidateWallets)
    .where(eq(candidateWallets.address, address))
    .limit(1);
  const cand = rows[0];
  if (!cand) return c.json({ error: "not_a_candidate" }, 404);
  await trackWallet(db, address, cand.handle ?? cand.displayName ?? null, cand.source);
  await db
    .update(candidateWallets)
    .set({ promoted: true })
    .where(eq(candidateWallets.address, address));
  return c.json({ promoted: address });
});
