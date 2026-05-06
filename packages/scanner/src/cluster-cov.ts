// Phase 5b: compute coefficient-of-variation across cluster members'
// recent SOL outflow patterns. A low CoV ⇒ all members are sending
// suspiciously similar amounts ⇒ bot-coordinated → SYBIL tag fires.
//
// Phase 2 designed this but stubbed cluster.cov to null because the
// per-sibling tx fetch was deemed too expensive on shared mode. With
// paid Helius + the 429 retry shipped in 9c735d5, the cost (~50 extra
// enhanced-tx calls per scan, bounded by Semaphore) is acceptable.

import { computeCov } from "./cluster";
import type { HeliusClient } from "./helius-client";
import { PROCESS_HELIUS_SEMAPHORE, Semaphore } from "./semaphore";
import type { ParsedTx } from "./tx-patterns";

export const COV_SAMPLE_SIZE = 50; // max cluster members to sample
export const COV_TX_PER_WALLET = 20; // tx fetched per sampled member
export const COV_PER_SCAN_CONCURRENCY = 10; // bound concurrent helius fan-out

export async function computeClusterCov(
  client: HeliusClient,
  memberAddresses: string[],
  target: string,
): Promise<number | null> {
  // Skip target itself; sample bounded.
  const samples = memberAddresses.filter((a) => a !== target).slice(0, COV_SAMPLE_SIZE);
  if (samples.length < 3) return null; // need ≥3 wallets for variance to be meaningful

  const perScan = new Semaphore(COV_PER_SCAN_CONCURRENCY);
  const amountsByWallet = new Map<string, number[]>();

  await Promise.all(
    samples.map((addr) =>
      perScan.run(() =>
        PROCESS_HELIUS_SEMAPHORE.run(async () => {
          try {
            const txs = await client.transactions(addr, COV_TX_PER_WALLET);
            const outflows = extractSolOutflows(addr, txs);
            if (outflows.length > 0) amountsByWallet.set(addr, outflows);
          } catch (e) {
            // Per-member errors are non-fatal — one bad wallet doesn't kill
            // the CoV signal. Just skip.
            console.error(`[cluster-cov] tx fetch ${addr} failed`, e);
          }
        }),
      ),
    ),
  );

  return computeCov(amountsByWallet);
}

// Pull SOL amounts the wallet sent OUT (not received). Only swap-style
// outbound flow is signal — inbound dust airdrops would skew the mean.
function extractSolOutflows(wallet: string, txs: ParsedTx[]): number[] {
  const amounts: number[] = [];
  for (const tx of txs) {
    const transfers = tx.nativeTransfers ?? [];
    for (const t of transfers) {
      if (t.fromUserAccount === wallet && t.amount > 0) {
        amounts.push(t.amount);
      }
    }
  }
  return amounts;
}
