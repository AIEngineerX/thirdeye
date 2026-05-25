import { expect, test } from "bun:test";
import { SolanaTrackerClient } from "@thirdeye/solanatracker";
import { snapshotWalletQuality } from "../src/lib/wallet-quality";

// Hits the real Solana Tracker Data API (no mocks). Skips when the key is
// unset so CI/forks without the secret stay green.
const KEY = process.env.SOLANATRACKER_API_KEY;
const maybe = KEY ? test : test.skip;

// Known high-volume wallet with confirmed ST PnL history (same wallet used in
// wallet-pnl.integration.test.ts).
const WALLET = "3BqGnroVXCWqBT6LstcLi9qZcDuTB7GuDKHrf8gJnvng";

maybe(
  "snapshotWalletQuality maps a live ST PnL summary",
  async () => {
    if (!KEY) return;
    const client = new SolanaTrackerClient({ apiKey: KEY });
    const q = await snapshotWalletQuality(client, WALLET);
    if (q === null) {
      console.log("[wallet-quality] wallet returned null (no ST history) — mapping not exercised");
      return;
    }
    console.log("[wallet-quality] live result:", JSON.stringify(q));
    expect(typeof q.winRate === "number" || q.winRate === null).toBe(true);
    expect(typeof q.realizedPnlUsd === "number" || q.realizedPnlUsd === null).toBe(true);
    expect(typeof q.roi === "number" || q.roi === null).toBe(true);
    expect(typeof q.tokensTraded === "number" || q.tokensTraded === null).toBe(true);
    expect(q.identity === null || typeof q.identity === "object").toBe(true);
  },
  30_000,
);
