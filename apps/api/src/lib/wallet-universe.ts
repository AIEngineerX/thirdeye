import { type DbClient, candidateWallets } from "@thirdeye/db";
import type { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { and, desc, eq, sql } from "drizzle-orm";

// Pull the ST PnL leaderboard into candidate_wallets (source='st_leaderboard').
// Rank = position in the returned list. Returns the number upserted.
export async function syncLeaderboardCandidates(
  db: DbClient,
  client: Pick<SolanaTrackerClient, "leaderboard">,
): Promise<number> {
  const lb = await client.leaderboard();
  let n = 0;
  for (let i = 0; i < lb.traders.length; i++) {
    const tr = lb.traders[i]!;
    await db
      .insert(candidateWallets)
      .values({
        address: tr.wallet,
        source: "st_leaderboard",
        srcPnlAll: tr.period?.realized?.toString() ?? null,
        srcWinRate: tr.winRate?.toString() ?? null,
        srcRank: i + 1,
        tokensTraded: tr.counts?.tokensTraded ?? 0,
        displayName: tr.identity,
      })
      .onConflictDoUpdate({
        target: candidateWallets.address,
        set: {
          srcPnlAll: tr.period?.realized?.toString() ?? null,
          srcWinRate: tr.winRate?.toString() ?? null,
          srcRank: i + 1,
        },
      });
    n++;
  }
  return n;
}

export interface CandidateRow {
  address: string;
  handle: string | null;
  displayName: string | null;
  twitterHandle: string | null;
  source: string;
  srcPnlAll: number | null;
  srcWinRate: number | null;
  earlyRate: number | null;
  buysObserved: number;
  tokensTraded: number;
  promoted: boolean;
}

export async function listCandidates(
  db: DbClient,
  opts: { limit: number; includePromoted: boolean; source?: string },
): Promise<CandidateRow[]> {
  const conds = [];
  if (!opts.includePromoted) conds.push(eq(candidateWallets.promoted, false));
  if (opts.source) conds.push(eq(candidateWallets.source, opts.source));
  const rows = await db
    .select()
    .from(candidateWallets)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${candidateWallets.earlyRate} DESC NULLS LAST`, desc(candidateWallets.srcPnlAll))
    .limit(opts.limit);
  return rows.map((r) => ({
    address: r.address,
    handle: r.handle,
    displayName: r.displayName,
    twitterHandle: r.twitterHandle,
    source: r.source,
    srcPnlAll: r.srcPnlAll === null ? null : Number(r.srcPnlAll),
    srcWinRate: r.srcWinRate === null ? null : Number(r.srcWinRate),
    earlyRate: r.earlyRate === null ? null : Number(r.earlyRate),
    buysObserved: r.buysObserved,
    tokensTraded: r.tokensTraded,
    promoted: r.promoted,
  }));
}
