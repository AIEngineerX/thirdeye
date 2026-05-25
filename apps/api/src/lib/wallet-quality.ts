import type { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { SolanaTrackerError } from "@thirdeye/solanatracker";

export interface WalletQuality {
  winRate: number | null;
  realizedPnlUsd: number | null;
  roi: number | null;
  tokensTraded: number | null;
  identity: Record<string, unknown> | null;
}

// One ST call (walletPnl). Returns null on 404 (no trading history) so the
// caller can still add the wallet with empty quality. Other errors propagate.
export async function snapshotWalletQuality(
  client: SolanaTrackerClient,
  wallet: string,
): Promise<WalletQuality | null> {
  try {
    const s = await client.walletPnl(wallet);
    return {
      winRate: s.analysis?.winRate ?? null,
      realizedPnlUsd: s.summary?.pnl?.realized ?? null,
      roi: s.summary?.roi ?? null,
      tokensTraded: s.summary?.counts?.tokensTraded ?? null,
      identity: s.identity === null ? null : ({ name: s.identity } as Record<string, unknown>),
    };
  } catch (e) {
    if (e instanceof SolanaTrackerError && e.status === 404) return null;
    throw e;
  }
}
