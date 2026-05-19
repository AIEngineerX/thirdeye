import { describe, expect, test } from "bun:test";
import type { TokenScanResult, WalletCheckResult } from "@thirdeye/scanner";
import { summarizeTokenScanForLLM, summarizeWalletForLLM } from "../src/summarize";

const FIXTURE: WalletCheckResult = {
  address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1",
  mode: "shared",
  identity: {
    address: "VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1",
    name: null,
    type: null,
    category: null,
  },
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

const TOKEN_FIXTURE: TokenScanResult = {
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  mode: "shared",
  metadata: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    name: "Example Coin",
    symbol: "EX",
    supply: "1000000000",
    decimals: 6,
    updateAuthority: null,
    firstCreator: null,
  },
  totalHolders: 250,
  scannedHolders: 200,
  topHolders: Array.from({ length: 200 }, (_, i) => ({
    owner: `Holder${i.toString().padStart(3, "0")}AddressLongEnoughLooksLikeB58XXXXXXXXX`,
    amount: String(1_000_000 - i),
    pct: 5 - i * 0.01,
  })),
  lp: { totalPct: 12.3, holders: [] },
  locked: { totalPct: 0, holders: [] },
  clusters: Array.from({ length: 20 }, (_, i) => ({
    root: `Funder${i.toString().padStart(3, "0")}AddrXXXXXXXXXXXXXXXXXXXXXXX`,
    members: Array.from({ length: 30 }, (_, j) => `MemberC${i}M${j}AddrXXXXXXXXXXXXXXXXXXXX`),
    totalPct: 4.5 - i * 0.1,
    isFreshFunder: i % 3 === 0,
    priorTags: Object.fromEntries(
      Array.from({ length: 30 }, (_, j) => [
        `MemberC${i}M${j}AddrXXXXXXXXXXXXXXXXXXXX`,
        ["BUNDLER"],
      ]),
    ),
  })),
  totalClusteredPct: 64.5,
  maxClusterPct: 4.5,
  freshFunderCount: 7,
  risk: 78,
  sybilFlag: true,
  verdict: "HIGH_RISK",
  scannedAt: "2026-05-19T12:00:00.000Z",
};

describe("summarizeTokenScanForLLM (M7)", () => {
  test("returns a compact summary instead of the raw TokenScanResult", () => {
    const s = summarizeTokenScanForLLM(TOKEN_FIXTURE);
    expect(s.mint).toBe(TOKEN_FIXTURE.mint);
    expect(s.symbol).toBe("EX");
    expect(s.totalHolders).toBe(250);
    expect(s.scannedHolders).toBe(200);
    expect(s.risk).toBe(78);
    expect(s.sybilFlag).toBe(true);
    expect(s.verdict).toBe("HIGH_RISK");
    expect(s.lp.totalPct).toBe(12.3);
    expect(s.totalClusteredPct).toBe(64.5);
    expect(s.maxClusterPct).toBe(4.5);
  });

  test("caps topHolders at 5", () => {
    const s = summarizeTokenScanForLLM(TOKEN_FIXTURE);
    expect(s.topHolders.length).toBe(5);
    expect(s.topHolders[0]!.owner).toBe(TOKEN_FIXTURE.topHolders[0]!.owner);
  });

  test("caps clusters at 10 and drops full member lists", () => {
    const s = summarizeTokenScanForLLM(TOKEN_FIXTURE);
    expect(s.clusters.length).toBe(10);
    for (const c of s.clusters) {
      // memberCount is preserved; the full array is not
      expect(c.memberCount).toBe(30);
      expect(c).not.toHaveProperty("members");
      expect(c).not.toHaveProperty("priorTags");
      // priorTagSummary rolls per-member tags into counts
      expect(c.priorTagSummary.BUNDLER).toBe(30);
    }
  });

  test("payload size is dramatically smaller than raw (budget-exhaustion vector closed)", () => {
    const raw = new TextEncoder().encode(JSON.stringify(TOKEN_FIXTURE)).length;
    const summarized = new TextEncoder().encode(
      JSON.stringify(summarizeTokenScanForLLM(TOKEN_FIXTURE)),
    ).length;
    // Raw fixture is tens of KB; summary should be well under 4 KB.
    expect(summarized).toBeLessThan(4096);
    expect(summarized).toBeLessThan(raw / 5);
  });

  test("handles a token with no clusters / no holders gracefully", () => {
    const empty: TokenScanResult = {
      ...TOKEN_FIXTURE,
      topHolders: [],
      clusters: [],
      totalHolders: 0,
      scannedHolders: 0,
      totalClusteredPct: 0,
      maxClusterPct: 0,
    };
    const s = summarizeTokenScanForLLM(empty);
    expect(s.topHolders).toEqual([]);
    expect(s.clusters).toEqual([]);
  });
});
