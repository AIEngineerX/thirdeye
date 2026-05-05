import { type DbClient, walletChecks, wallets } from "@thirdeye/db";
import type { WalletCheckResult } from "@thirdeye/scanner";
import { sql } from "drizzle-orm";

export async function persistCheck(db: DbClient, r: WalletCheckResult): Promise<void> {
  const firstFunder = r.funding.chain[0]?.funder ?? null;
  const fundedAt = r.funding.chain[0]?.fundedAt ?? null;

  await db
    .insert(wallets)
    .values({
      address: r.address,
      firstFunder,
      ...(fundedAt !== null && { fundedAt: new Date(fundedAt) }),
      solBalance: String(r.balances.solBalance),
      usdValue: String(r.balances.usdValue),
      txCount: r.txPattern.txCount,
      ageDays: r.txPattern.ageDays,
      tags: r.tags,
      lastChecked: new Date(),
    })
    .onConflictDoUpdate({
      target: wallets.address,
      set: {
        firstFunder: sql`COALESCE(${wallets.firstFunder}, EXCLUDED.first_funder)`,
        fundedAt: sql`COALESCE(${wallets.fundedAt}, EXCLUDED.funded_at)`,
        solBalance: sql`EXCLUDED.sol_balance`,
        usdValue: sql`EXCLUDED.usd_value`,
        txCount: sql`EXCLUDED.tx_count`,
        ageDays: sql`EXCLUDED.age_days`,
        tags: sql`EXCLUDED.tags`,
        lastChecked: sql`EXCLUDED.last_checked`,
      },
    });

  await db.insert(walletChecks).values({
    address: r.address,
    score: r.score,
    verdict: r.verdict,
    payload: r as unknown as Record<string, unknown>,
  });

  if (firstFunder !== null) {
    await db.execute(sql`
      INSERT INTO funders (address, fanout_count, cluster_count, first_seen, last_seen)
      VALUES (${firstFunder}, 1, 0, now(), now())
      ON CONFLICT (address) DO UPDATE SET
        fanout_count = funders.fanout_count + 1,
        last_seen = now()
    `);
  }
}

export async function lookupRecentCheck(
  db: DbClient,
  address: string,
  cacheHours: number,
): Promise<WalletCheckResult | null> {
  const cutoffIso = new Date(Date.now() - cacheHours * 3600 * 1000).toISOString();
  const rows = await db
    .select()
    .from(walletChecks)
    .where(
      sql`${walletChecks.address} = ${address} AND ${walletChecks.checkedAt} >= ${cutoffIso}::timestamptz`,
    )
    .orderBy(sql`${walletChecks.checkedAt} DESC`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.payload as unknown as WalletCheckResult;
}

export async function resolveSiblings(
  db: DbClient,
  firstFunder: string,
  limit: number,
): Promise<{ address: string; fundedAt: string | null }[]> {
  const rows = await db
    .select({ address: wallets.address, fundedAt: wallets.fundedAt })
    .from(wallets)
    .where(sql`${wallets.firstFunder} = ${firstFunder}`)
    .limit(limit);
  return rows.map((r) => ({
    address: r.address,
    fundedAt: r.fundedAt ? r.fundedAt.toISOString() : null,
  }));
}
