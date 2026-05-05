import type { TxPattern } from "./types";

export interface ParsedTx {
  signature: string;
  timestamp: number; // unix seconds
  type: string | null; // "SWAP" | "TRANSFER" | etc
  source: string | null;
  destination: string | null;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
}

const RAPID_FIRE_GAP_SEC = 60;

export function analyzeTxPattern(target: string, txs: ParsedTx[]): TxPattern {
  if (txs.length === 0) {
    return {
      txCount: 0,
      ageDays: 0,
      avgGapSec: null,
      swapOnly: false,
      rapidFire: false,
      uniqueOutboundRecipients: 0,
    };
  }

  const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const firstTs = sorted[0]!.timestamp;
  const ageDays = Math.max(0, Math.floor((Date.now() / 1000 - firstTs) / 86_400));

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i]!.timestamp - sorted[i - 1]!.timestamp);
  }
  const avgGapSec = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const rapidFire = avgGapSec !== null && avgGapSec < RAPID_FIRE_GAP_SEC;

  const types = new Set(txs.map((t) => t.type).filter((t): t is string => t !== null));
  const swapOnly = types.size === 1 && types.has("SWAP");

  const recipients = new Set<string>();
  for (const tx of txs) {
    for (const transfer of tx.nativeTransfers ?? []) {
      if (transfer.fromUserAccount === target && transfer.amount > 0) {
        recipients.add(transfer.toUserAccount);
      }
    }
  }

  return {
    txCount: txs.length,
    ageDays,
    avgGapSec,
    swapOnly,
    rapidFire,
    uniqueOutboundRecipients: recipients.size,
  };
}
