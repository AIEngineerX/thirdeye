// Dev-only: seed candidate_wallets from a local fomo.family tracked-trader
// corpus SQLite. Computes observed behavior (buys, early-entry rate, distinct
// tokens) from fomo_wallet_buys and enriches identity/PnL from fomo_wallets.
// Usage: bun run scripts/seed/fomo-candidates.ts <corpus.sqlite> [earlyMcThreshold]
import { Database } from "bun:sqlite";
import { candidateWallets, createDb } from "@thirdeye/db";

const EARLY_MC_DEFAULT = 100_000;

interface Agg {
  address: string;
  buys: number;
  early: number;
  tokens: Set<string>;
}

async function main(): Promise<void> {
  const [path, thresholdArg] = process.argv.slice(2);
  if (!path) throw new Error("usage: fomo-candidates.ts <corpus.sqlite> [earlyMcThreshold]");
  const earlyMc = thresholdArg ? Number(thresholdArg) : EARLY_MC_DEFAULT;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");

  const corpus = new Database(path, { readonly: true });
  const buys = corpus
    .query(
      `SELECT wallet_address AS wallet, token_address AS mint, market_cap_usd AS mc
       FROM fomo_wallet_buys WHERE side='buy'`,
    )
    .all() as Array<{ wallet: string; mint: string; mc: number | null }>;

  const aggs = new Map<string, Agg>();
  for (const b of buys) {
    let a = aggs.get(b.wallet);
    if (!a) {
      a = { address: b.wallet, buys: 0, early: 0, tokens: new Set() };
      aggs.set(b.wallet, a);
    }
    a.buys++;
    a.tokens.add(b.mint);
    if (b.mc !== null && b.mc < earlyMc) a.early++;
  }

  const dir = new Map<
    string,
    {
      handle: string | null;
      display: string | null;
      twitter: string | null;
      pnl7d: number | null;
      pnlAll: number | null;
      winRate: number | null;
      rank: number | null;
    }
  >();
  for (const r of corpus
    .query(
      `SELECT wallet_address AS w, handle, display_name AS dn, twitter_handle AS tw,
              pnl_7d, pnl_all, win_rate, leaderboard_rank AS rank FROM fomo_wallets`,
    )
    .all() as Array<Record<string, unknown>>) {
    dir.set(r.w as string, {
      handle: (r.handle as string) ?? null,
      display: (r.dn as string) ?? null,
      twitter: (r.tw as string) ?? null,
      pnl7d: r.pnl_7d === null ? null : Number(r.pnl_7d),
      pnlAll: r.pnl_all === null ? null : Number(r.pnl_all),
      winRate: r.win_rate === null ? null : Number(r.win_rate),
      rank: r.rank === null ? null : Number(r.rank),
    });
  }
  corpus.close();

  const { db } = createDb(url);
  let upserts = 0;
  for (const a of aggs.values()) {
    const d = dir.get(a.address);
    const earlyRate = a.buys > 0 ? a.early / a.buys : null;
    await db
      .insert(candidateWallets)
      .values({
        address: a.address,
        handle: d?.handle ?? null,
        displayName: d?.display ?? null,
        twitterHandle: d?.twitter ?? null,
        source: "fomo_seed",
        srcPnl7d: d?.pnl7d?.toString() ?? null,
        srcPnlAll: d?.pnlAll?.toString() ?? null,
        srcWinRate: d?.winRate?.toString() ?? null,
        srcRank: d?.rank ?? null,
        buysObserved: a.buys,
        earlyBuys: a.early,
        earlyRate: earlyRate?.toString() ?? null,
        tokensTraded: a.tokens.size,
      })
      .onConflictDoUpdate({
        target: candidateWallets.address,
        set: {
          buysObserved: a.buys,
          earlyBuys: a.early,
          earlyRate: earlyRate?.toString() ?? null,
          tokensTraded: a.tokens.size,
        },
      });
    upserts++;
  }
  console.log(`seeded ${upserts} fomo candidates (earlyMc<$${earlyMc.toLocaleString()})`);
  process.exit(0);
}

main();
