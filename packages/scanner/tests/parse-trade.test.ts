import { expect, test } from "bun:test";
import buyFixture from "./fixtures/helius-swap-buy.json";
import sellFixture from "./fixtures/helius-swap-sell.json";
import { parseWalletTrade } from "../src/parse-trade";

const WALLET = "WaLLeT1111111111111111111111111111111111111";
const MINT = "MiNT2222222222222222222222222222222222222222";

test("parses a buy: token in, SOL out", () => {
  const t = parseWalletTrade(buyFixture, WALLET);
  expect(t).not.toBeNull();
  expect(t!.side).toBe("buy");
  expect(t!.mint).toBe(MINT);
  expect(t!.tokenAmount).toBe(1000000);
  expect(t!.solAmount).toBeCloseTo(1.5, 3);
  expect(t!.program).toBe("JUPITER");
  expect(t!.signature).toBe(buyFixture.signature);
  expect(t!.tradedAt.toISOString()).toBe("2026-05-25T00:00:00.000Z");
});

test("parses a sell: token out, SOL in", () => {
  const t = parseWalletTrade(sellFixture, WALLET);
  expect(t).not.toBeNull();
  expect(t!.side).toBe("sell");
  expect(t!.mint).toBe(MINT);
  expect(t!.solAmount).toBeCloseTo(2.0, 3);
});

test("returns null when the wallet has no token transfer in the event", () => {
  const t = parseWalletTrade(buyFixture, "OtherWaLLeT00000000000000000000000000000000");
  expect(t).toBeNull();
});

test("returns null for an event with no token transfers (plain SOL move)", () => {
  const t = parseWalletTrade(
    { signature: "x", timestamp: 1, tokenTransfers: [], nativeTransfers: [], accountData: [] },
    WALLET,
  );
  expect(t).toBeNull();
});
