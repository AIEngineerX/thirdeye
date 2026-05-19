import { describe, expect, test } from "bun:test";
import { type TagInputs, computeTags } from "../src/tags";
import type { Cluster, Identity, TxPattern } from "../src/types";

const cleanIdentity: Identity = { address: "x", name: null, type: null, category: null };
const exchangeIdentity: Identity = {
  address: "x",
  name: "Binance Hot Wallet",
  type: "exchange",
  category: "cex",
};

const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

function cluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    firstFunder: null,
    size: 1,
    siblings: [],
    timeWindowSiblings: [],
    cov: null,
    ...overrides,
  };
}

const baseTxPattern: TxPattern = {
  txCount: 10,
  ageDays: 100,
  avgGapSec: 1_000,
  swapOnly: false,
  rapidFire: false,
  uniqueOutboundRecipients: 0,
};

function makeInputs(overrides: Partial<TagInputs>): TagInputs {
  return {
    identity: cleanIdentity,
    ageDays: 100,
    txCount: 100,
    usdValue: 0,
    tokenCount: 0,
    cluster: cluster(),
    txPattern: baseTxPattern,
    realizedPnlSol: null,
    smartMoneyMinSol: 50,
    ...overrides,
  };
}

describe("computeTags", () => {
  test("EXCHANGE from identity.type", () => {
    const tags = computeTags({
      identity: exchangeIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster(),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("EXCHANGE");
  });

  test("EXCHANGE from cluster.firstFunder being a CEX address", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster({ firstFunder: BINANCE }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("EXCHANGE");
  });

  test("FRESH_WALLET when ageDays<14 AND txCount<20", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 5,
      txCount: 10,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster(),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("FRESH_WALLET");
  });

  test("FRESH_WALLET does NOT fire on zero-tx wallets (B3)", () => {
    // tx-patterns.ts returns ageDays=0 / txCount=0 as the no-parseable-txs
    // sentinel. An old wallet whose history Helius can't enhanced-parse
    // would otherwise wrongly satisfy (0<14 && 0<20) and get tagged FRESH.
    const tags = computeTags(makeInputs({ ageDays: 0, txCount: 0 }));
    expect(tags).not.toContain("FRESH_WALLET");
  });

  test("FRESH_WALLET still fires for genuine fresh wallet at minimum txCount=1", () => {
    const tags = computeTags(makeInputs({ ageDays: 1, txCount: 1 }));
    expect(tags).toContain("FRESH_WALLET");
  });

  test("BUNDLER when cluster.size >= 2 and funder is non-exchange", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster({ size: 5, firstFunder: "non-cex-funder" }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
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
      cluster: cluster({ size: 10, firstFunder: BINANCE }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).not.toContain("BUNDLER");
  });

  test("no BUNDLER when funder is null", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster({ size: 10, firstFunder: null }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
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
      cluster: cluster({
        size: 5,
        firstFunder: "f",
        timeWindowSiblings: ["a", "b", "c"],
      }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("BUNDLER");
    expect(tags).toContain("BUNDLER_TIGHT");
  });

  test("SYBIL requires BUNDLER and CoV < 0.20", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster({ size: 5, firstFunder: "f", cov: 0.05 }),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("SYBIL");
  });

  test("SNIPER requires rapidFire AND swapOnly AND avgGapSec<30", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster(),
      txPattern: { ...baseTxPattern, rapidFire: true, swapOnly: true, avgGapSec: 15 },
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("SNIPER");
  });

  test("WHALE requires usdValue>50k AND tokenCount<=10", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 75_000,
      tokenCount: 3,
      cluster: cluster(),
      txPattern: baseTxPattern,
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("WHALE");
  });

  test("FUND_DISTRIBUTOR when uniqueOutboundRecipients >= 10", () => {
    const tags = computeTags({
      identity: cleanIdentity,
      ageDays: 100,
      txCount: 100,
      usdValue: 0,
      tokenCount: 0,
      cluster: cluster(),
      txPattern: { ...baseTxPattern, uniqueOutboundRecipients: 25 },
      realizedPnlSol: null,
      smartMoneyMinSol: 50,
    });
    expect(tags).toContain("FUND_DISTRIBUTOR");
  });

  test("SMART_MONEY when realizedPnlSol >= threshold", () => {
    const tags = computeTags(makeInputs({ realizedPnlSol: 75, smartMoneyMinSol: 50 }));
    expect(tags).toContain("SMART_MONEY");
  });

  test("no SMART_MONEY when below threshold", () => {
    const tags = computeTags(makeInputs({ realizedPnlSol: 25, smartMoneyMinSol: 50 }));
    expect(tags).not.toContain("SMART_MONEY");
  });

  test("no SMART_MONEY when realizedPnlSol is null", () => {
    const tags = computeTags(makeInputs({ realizedPnlSol: null, smartMoneyMinSol: 50 }));
    expect(tags).not.toContain("SMART_MONEY");
  });

  test("SMART_MONEY suppressed when wallet identity is exchange", () => {
    const tags = computeTags(
      makeInputs({
        identity: exchangeIdentity,
        realizedPnlSol: 1000,
        smartMoneyMinSol: 50,
      }),
    );
    expect(tags).not.toContain("SMART_MONEY");
    expect(tags).toContain("EXCHANGE");
  });

  test("SMART_MONEY suppressed when funder is a known exchange", () => {
    const tags = computeTags(
      makeInputs({
        cluster: cluster({ firstFunder: BINANCE }),
        realizedPnlSol: 1000,
        smartMoneyMinSol: 50,
      }),
    );
    expect(tags).not.toContain("SMART_MONEY");
  });

  test("SMART_MONEY does not fire on negative PnL", () => {
    const tags = computeTags(makeInputs({ realizedPnlSol: -100, smartMoneyMinSol: 50 }));
    expect(tags).not.toContain("SMART_MONEY");
  });
});
