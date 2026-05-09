import { describe, expect, test } from "bun:test";
import type { WalletCheckResult } from "@thirdeye/scanner";
import { summarizeWalletForLLM } from "../src/summarize";

const FIXTURE: WalletCheckResult = {
  address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1",
  mode: "shared",
  identity: { address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1", name: null, type: null, category: null },
  balances: {
    solBalance: 12.4,
    usdValue: 1840.5,
    tokenCount: 47,
    tokens: Array.from({ length: 47 }, (_, i) => ({
      mint: `mint${i}`,
      amount: String(i),
      decimals: 6,
      symbol: `TKN${i}`,
      name: null,
      usdValue: i,
    })),
  },
  funding: {
    chain: [
      {
        depth: 0,
        address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1",
        funder: "MidA",
        fundedAt: "2025-04-01T00:00:00Z",
        signature: "sig1",
        isExchange: false,
        isLaunchpad: false,
      },
      {
        depth: 1,
        address: "MidA",
        funder: "Bin1",
        fundedAt: "2025-03-30T00:00:00Z",
        signature: "sig2",
        isExchange: false,
        isLaunchpad: false,
      },
      {
        depth: 2,
        address: "Bin1",
        funder: null,
        fundedAt: null,
        signature: null,
        isExchange: true,
        isLaunchpad: false,
      },
    ],
  },
  cluster: {
    firstFunder: "Bin1",
    size: 8,
    siblings: Array.from({ length: 8 }, (_, i) => ({
      address: `S${i}`,
      fundedAt: null,
      identity: null,
    })),
    timeWindowSiblings: ["S0", "S1", "S2"],
    cov: 0.73,
  },
  txPattern: {
    txCount: 3201,
    ageDays: 412,
    avgGapSec: 200,
    swapOnly: false,
    rapidFire: false,
    uniqueOutboundRecipients: 19,
  },
  tags: ["BUNDLER", "SMART_MONEY"],
  realizedPnlSol: 18.7,
  score: 62,
  scoreBucket: "MEDIUM",
  verdict: "SMART_MONEY",
  scannedAt: "2026-05-09T00:00:00Z",
};

describe("summarizeWalletForLLM", () => {
  test("emits all required fields per spec §3", () => {
    const s = summarizeWalletForLLM(FIXTURE);
    expect(s.address).toBe(FIXTURE.address);
    expect(s.ageDays).toBe(412);
    expect(s.txCount).toBe(3201);
    expect(s.usdValue).toBe(1840.5);
    expect(s.tokenCount).toBe(47);
    expect(s.tags).toEqual(["BUNDLER", "SMART_MONEY"]);
    expect(s.score).toBe(62);
    expect(s.scoreBucket).toBe("MEDIUM");
    expect(s.verdict).toBe("SMART_MONEY");
    expect(s.realizedPnlSol).toBe(18.7);
    expect(s.cluster.firstFunder).toBe("Bin1");
    expect(s.cluster.size).toBe(8);
    expect(s.cluster.cov).toBe(0.73);
    expect(s.cluster.timeWindowSiblingCount).toBe(3);
    expect(s.funding.hops).toBe(3);
    expect(s.funding.rootIsExchange).toBe(true);
  });

  test("serialized JSON stays under 2KB (≈ 500 tokens)", () => {
    const s = summarizeWalletForLLM(FIXTURE);
    const bytes = new TextEncoder().encode(JSON.stringify(s)).length;
    expect(bytes).toBeLessThan(2048);
  });

  test("topActivity is shipped as [] in 6b (scanner extension is 6c work)", () => {
    expect(summarizeWalletForLLM(FIXTURE).topActivity).toEqual([]);
  });

  test("rootIsExchange=false when funding chain root is a wallet", () => {
    const noExchange: WalletCheckResult = {
      ...FIXTURE,
      funding: {
        chain: [
          {
            depth: 0,
            address: "A",
            funder: null,
            fundedAt: null,
            signature: null,
            isExchange: false,
            isLaunchpad: false,
          },
        ],
      },
    };
    expect(summarizeWalletForLLM(noExchange).funding.rootIsExchange).toBe(false);
  });

  test("cov=null is preserved (sparse cluster)", () => {
    const sparse: WalletCheckResult = {
      ...FIXTURE,
      cluster: { ...FIXTURE.cluster, cov: null },
    };
    expect(summarizeWalletForLLM(sparse).cluster.cov).toBeNull();
  });
});
