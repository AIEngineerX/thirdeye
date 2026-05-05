import { describe, expect, test } from "bun:test";
import { computeTags } from "../src/tags";
import type { Cluster, Identity, TxPattern } from "../src/types";

const cleanIdentity: Identity = { address: "x", name: null, type: null, category: null };
const exchangeIdentity: Identity = {
  address: "x",
  name: "Binance Hot Wallet",
  type: "exchange",
  category: "cex",
};

const noCluster: Cluster = {
  firstFunder: null,
  size: 1,
  siblings: [],
  timeWindowSiblings: [],
  cov: null,
};

const baseTxPattern: TxPattern = {
  txCount: 10,
  ageDays: 100,
  avgGapSec: 1_000,
  swapOnly: false,
  rapidFire: false,
  uniqueOutboundRecipients: 0,
};

describe("computeTags", () => {
  test("EXCHANGE from identity.type", () => {
    const tags = computeTags({
      identity: exchangeIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: noCluster,
      txPattern: baseTxPattern,
      firstFunder: null,
    });
    expect(tags).toContain("EXCHANGE");
  });

  test("FRESH_WALLET when ageDays<30 AND txCount<50", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 5,
      txCount: 10,
      usdValue: 0,
      tokenCount: 0,
      cluster: noCluster,
      txPattern: baseTxPattern,
      firstFunder: null,
    });
    expect(tags).toContain("FRESH_WALLET");
  });

  test("BUNDLER when cluster.size >= 3 and funder is non-exchange", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: { ...noCluster, size: 5, firstFunder: "non-cex-funder" },
      txPattern: baseTxPattern,
      firstFunder: "non-cex-funder",
    });
    expect(tags).toContain("BUNDLER");
  });

  test("no BUNDLER when funder is an exchange", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: {
        ...noCluster,
        size: 10,
        firstFunder: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
      },
      txPattern: baseTxPattern,
      firstFunder: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
    });
    expect(tags).not.toContain("BUNDLER");
  });

  test("BUNDLER_TIGHT requires BUNDLER and >=3 timeWindow siblings", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: {
        ...noCluster,
        size: 5,
        firstFunder: "f",
        timeWindowSiblings: ["a", "b", "c"],
      },
      txPattern: baseTxPattern,
      firstFunder: "f",
    });
    expect(tags).toContain("BUNDLER");
    expect(tags).toContain("BUNDLER_TIGHT");
  });

  test("SYBIL requires BUNDLER and CoV < 0.15", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: { ...noCluster, size: 5, firstFunder: "f", cov: 0.05 },
      txPattern: baseTxPattern,
      firstFunder: "f",
    });
    expect(tags).toContain("SYBIL");
  });

  test("SNIPER requires rapidFire AND swapOnly AND avgGapSec<60", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: noCluster,
      txPattern: { ...baseTxPattern, rapidFire: true, swapOnly: true, avgGapSec: 30 },
      firstFunder: null,
    });
    expect(tags).toContain("SNIPER");
  });

  test("WHALE requires usdValue>10k AND tokenCount<=5", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 50_000,
      tokenCount: 3,
      cluster: noCluster,
      txPattern: baseTxPattern,
      firstFunder: null,
    });
    expect(tags).toContain("WHALE");
  });

  test("FUND_DISTRIBUTOR when uniqueOutboundRecipients >= 20", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: noCluster,
      txPattern: { ...baseTxPattern, uniqueOutboundRecipients: 25 },
      firstFunder: null,
    });
    expect(tags).toContain("FUND_DISTRIBUTOR");
  });
});
