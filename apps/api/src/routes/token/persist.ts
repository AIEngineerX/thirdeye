import { type DbClient, tokenScans, wallets } from "@thirdeye/db";
import type { TokenScanResult } from "@thirdeye/scanner";
import { inArray, sql } from "drizzle-orm";

export async function persistScan(db: DbClient, r: TokenScanResult): Promise<void> {
  await db.insert(tokenScans).values({
    mint: r.mint,
    symbol: r.metadata.symbol,
    name: r.metadata.name,
    launchpad: null,
    totalHolders: r.totalHolders,
    scannedHolders: r.scannedHolders,
    clusterCount: r.clusters.length,
    clusteredPct: String(r.totalClusteredPct),
    lpPct: String(r.lp.totalPct),
    lockedPct: String(r.locked.totalPct),
    riskPct: String(r.risk),
    sybilFlag: r.sybilFlag,
    verdict: r.verdict,
    payload: r as unknown as Record<string, unknown>,
  });

  // Increment cluster_count on each detected funder root.
  for (const c of r.clusters) {
    await db.execute(sql`
      INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen)
      VALUES (${c.root}, 0, 1, now(), now())
      ON CONFLICT (address) DO UPDATE SET
        cluster_count = funders.cluster_count + 1,
        last_seen = now()
    `);
  }
}

export async function lookupRecentScan(
  db: DbClient,
  mint: string,
  cacheSec: number,
): Promise<TokenScanResult | null> {
  const cutoffIso = new Date(Date.now() - cacheSec * 1000).toISOString();
  const rows = await db
    .select()
    .from(tokenScans)
    .where(
      sql`${tokenScans.mint} = ${mint} AND ${tokenScans.scannedAt} >= ${cutoffIso}::timestamptz`,
    )
    .orderBy(sql`${tokenScans.scannedAt} DESC`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.payload as unknown as TokenScanResult;
}

export async function resolvePriorTags(
  db: DbClient,
  addresses: string[],
): Promise<Map<string, string[]>> {
  if (addresses.length === 0) return new Map();
  const rows = await db
    .select({ address: wallets.address, tags: wallets.tags })
    .from(wallets)
    .where(inArray(wallets.address, addresses));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    map.set(r.address, (r.tags as string[]) ?? []);
  }
  return map;
}
