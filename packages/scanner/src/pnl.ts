import type { ParsedTx } from "./tx-patterns";

const WINDOW_SEC = 30 * 86_400;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function computeRealizedSolPnl(target: string, txs: ParsedTx[]): number {
  if (txs.length === 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SEC;
  let netLamports = 0;
  for (const tx of txs) {
    if (tx.type !== "SWAP") continue;
    if (tx.timestamp < cutoff) continue;
    const transfers = tx.nativeTransfers ?? [];
    for (const t of transfers) {
      if (t.toUserAccount === target) netLamports += t.amount;
      if (t.fromUserAccount === target) netLamports -= t.amount;
    }
  }
  return netLamports / LAMPORTS_PER_SOL;
}
