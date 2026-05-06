// Phase 5d: realized SOL PnL across a wallet's recent SWAP history.
// "Realized" here means the net SOL flowing in/out as a side-effect of
// each SWAP — positive when the wallet sold a token for SOL, negative
// when it bought a token with SOL. Sum across the window is the
// realized SOL gain (or loss) over that period.
//
// Limitations (documented, not bugs — see Phase 5 design §5d):
// - 30-day window; we only fetch last 100 tx, so longer-history
//   wallets' realized PnL beyond 30d is hidden.
// - Doesn't account for unrealized PnL (current holdings × current price).
// - Network fees are bundled into the SOL flow but they're tiny relative
//   to swap sizes.

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
