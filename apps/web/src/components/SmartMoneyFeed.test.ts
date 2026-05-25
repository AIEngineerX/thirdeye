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
