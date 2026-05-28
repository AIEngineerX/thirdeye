import { expect, test } from "bun:test";
import type { SseFrame } from "@/lib/sse";
import { type SmartRow, reduceSmartMoney } from "./SmartMoneyFeed";

const tradeFrame: SseFrame = {
  event: "smartmoney:trade",
  data: {
    wallet: "W1",
    label: "alpha",
    winRate: 70,
    side: "buy",
    mint: "M",
    symbol: "TKN",
    solAmount: 1.5,
    signature: "s1",
    tradedAt: "2026-05-25T00:00:00.000Z",
  },
};

const confluenceFrame: SseFrame = {
  event: "smartmoney:confluence",
  data: {
    mint: "M",
    symbol: "TKN",
    wallets: ["W1", "W2"],
    count: 2,
    windowMin: 30,
    coFunded: false,
    sharedFunder: null,
  },
};

const signalFrame: SseFrame = {
  event: "smartmoney:signal",
  data: {
    id: 42,
    mint: "SMINT",
    symbol: "SIG",
    walletCount: 3,
    wallets: ["W1", "W2", "W3"],
    trust: "independent",
    sharedFunder: null,
    callMc: 500_000,
    firstBuyAt: "2026-05-25T01:00:00.000Z",
  },
};

const outcomeFrame: SseFrame = {
  event: "smartmoney:outcome",
  data: {
    id: 42,
    mint: "SMINT",
    symbol: "SIG",
    currentMc: 2_000_000,
    athMultiplier: 5.2,
    safeAthMultiplier: 4.1,
    isHit: true,
    status: "closed",
  },
};

// ── existing tests ────────────────────────────────────────────────────────────

test("reduceSmartMoney keeps only smartmoney events, newest first", () => {
  const rows = reduceSmartMoney([
    { event: "ping", data: {} } as SseFrame,
    tradeFrame,
    confluenceFrame,
  ]);
  expect(rows.length).toBe(2);
  expect(rows[0]!.kind).toBe("confluence");
  expect(rows[1]!.kind).toBe("trade");
});

test("confluence row carries the independence flag", () => {
  const rows: SmartRow[] = reduceSmartMoney([confluenceFrame]);
  expect(rows[0]!.kind).toBe("confluence");
  if (rows[0]!.kind === "confluence") {
    expect(rows[0]!.coFunded).toBe(false);
    expect(rows[0]!.count).toBe(2);
  }
});

// ── new signal / outcome tests ─────────────────────────────────────────────────

test("smartmoney:signal frame produces one kind:signal row with correct fields", () => {
  const rows = reduceSmartMoney([signalFrame]);
  expect(rows.length).toBe(1);
  expect(rows[0]!.kind).toBe("signal");
  if (rows[0]!.kind === "signal") {
    expect(rows[0]!.id).toBe(42);
    expect(rows[0]!.mint).toBe("SMINT");
    expect(rows[0]!.trust).toBe("independent");
    expect(rows[0]!.walletCount).toBe(3);
    // outcome fields seeded as null/false/open
    expect(rows[0]!.athMultiplier).toBeNull();
    expect(rows[0]!.isHit).toBe(false);
    expect(rows[0]!.status).toBe("open");
  }
});

test("signal then outcome with same id produces ONE row with patched outcome fields", () => {
  const rows = reduceSmartMoney([signalFrame, outcomeFrame]);
  // signals are prepended; no trade/confluence frames so length must be 1
  expect(rows.length).toBe(1);
  expect(rows[0]!.kind).toBe("signal");
  if (rows[0]!.kind === "signal") {
    expect(rows[0]!.id).toBe(42);
    expect(rows[0]!.walletCount).toBe(3); // preserved from signal
    expect(rows[0]!.trust).toBe("independent"); // preserved from signal
    expect(rows[0]!.athMultiplier).toBe(5.2);
    expect(rows[0]!.safeAthMultiplier).toBe(4.1);
    expect(rows[0]!.isHit).toBe(true);
    expect(rows[0]!.status).toBe("closed");
  }
});

test("outcome with no prior signal frame produces a minimal usable signal row", () => {
  const rows = reduceSmartMoney([outcomeFrame]);
  expect(rows.length).toBe(1);
  expect(rows[0]!.kind).toBe("signal");
  if (rows[0]!.kind === "signal") {
    expect(rows[0]!.id).toBe(42);
    expect(rows[0]!.mint).toBe("SMINT");
    expect(rows[0]!.athMultiplier).toBe(5.2);
    expect(rows[0]!.isHit).toBe(true);
    expect(rows[0]!.status).toBe("closed");
    // minimal defaults
    expect(rows[0]!.walletCount).toBe(0);
    expect(rows[0]!.trust).toBe("independent");
  }
});

test("signals appear before trade/confluence rows in returned list", () => {
  const rows = reduceSmartMoney([tradeFrame, confluenceFrame, signalFrame]);
  expect(rows[0]!.kind).toBe("signal");
  expect(rows[1]!.kind).toBe("confluence"); // newest trade/confluence first
  expect(rows[2]!.kind).toBe("trade");
});
