import type { DbClient } from "@thirdeye/db";
import { wallets } from "@thirdeye/db";
import type { ParsedTrade } from "@thirdeye/scanner";
import { and, count, desc, inArray, isNotNull, sql } from "drizzle-orm";

// Insert a parsed trade. Returns true if a row was inserted, false if the
// (signature, wallet) pair already existed (Helius retries the same event for
// up to 24h, so dedup is mandatory — otherwise confluence double-counts).
export async function persistTrade(
  db: DbClient,
  t: ParsedTrade,
  symbol: string | null,
): Promise<boolean> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO smart_trades
      (wallet, mint, symbol, side, sol_amount, token_amount, program, signature, traded_at)
    VALUES (
      ${t.wallet}, ${t.mint}, ${symbol}, ${t.side},
      ${t.solAmount}, ${t.tokenAmount}, ${t.program}, ${t.signature}, ${t.tradedAt.toISOString()}
    )
    ON CONFLICT (signature, wallet) DO NOTHING
    RETURNING id
  `);
  return (rows as unknown as { id: number }[]).length > 0;
}

export interface Confluence {
  mint: string;
  wallets: string[];
  count: number;
  windowMin: number;
}

// Distinct wallets that BOUGHT `mint` within the last `windowMin` minutes.
export async function detectBuyConfluence(
  db: DbClient,
  mint: string,
  windowMin: number,
): Promise<Confluence> {
  const rows = await db.execute<{ wallet: string }>(sql`
    SELECT DISTINCT wallet FROM smart_trades
    WHERE mint = ${mint}
      AND side = 'buy'
      AND traded_at >= now() - (${windowMin}::int * interval '1 minute')
    ORDER BY wallet
  `);
  const walletList = (rows as unknown as { wallet: string }[]).map((r) => r.wallet);
  return { mint, wallets: walletList, count: walletList.length, windowMin };
}

export interface CoFunded {
  coFunded: boolean;
  sharedFunder: string | null;
}

// Returns true when >=2 of the given addresses share the same first_funder.
// Uses Drizzle's inArray() to avoid the postgres.js + Bun array-binding bug
// (binding a JS array as text[] param fails under this stack).
export async function areCoFunded(db: DbClient, addresses: string[]): Promise<CoFunded> {
  if (addresses.length < 2) return { coFunded: false, sharedFunder: null };
  const rows = await db
    .select({ firstFunder: wallets.firstFunder, n: count() })
    .from(wallets)
    .where(and(inArray(wallets.address, addresses), isNotNull(wallets.firstFunder)))
    .groupBy(wallets.firstFunder)
    .orderBy(desc(count()))
    .limit(1);
  const top = rows[0];
  if (top && Number(top.n) >= 2 && top.firstFunder) {
    return { coFunded: true, sharedFunder: top.firstFunder };
  }
  return { coFunded: false, sharedFunder: null };
}
