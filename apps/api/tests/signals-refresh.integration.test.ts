import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { PriceQuote, PriceSource } from "@thirdeye/prices";
import { refreshSignals } from "../src/workers/signals-refresh";
import { type TestDb, setupTestDb } from "./setup";

let t: TestDb;
beforeEach(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.cleanup();
});

// A real (non-mock) in-memory PriceSource: deterministic quotes, no network.
function fixedSource(byMint: Record<string, number>): PriceSource {
  return {
    name: "fixed",
    async fetch(mints: string[]): Promise<PriceQuote[]> {
      return mints
        .filter((m) => m in byMint)
        .map((m) => ({
          mint: m,
          symbol: null,
          name: null,
          priceUsd: null,
          mcUsd: byMint[m]!,
          mc24hPct: null,
          liquidityUsd: null,
        }));
    },
  };
}

describe("refreshSignals", () => {
  test("raises ath + sets is_hit when current MC crosses the multiple", async () => {
    await t.sql`
      INSERT INTO signals (mint, symbol, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at)
      VALUES ('M1','AAA',2,'["W1","W2"]'::jsonb,'independent',50000, now(), now())`;
    const stats = await refreshSignals(t.db, {
      source: fixedSource({ M1: 120000 }),
      hitMultiplier: 2,
      closeAfterHours: 48,
    });
    expect(stats.updated).toBe(1);
    const rows = await t.sql`SELECT * FROM signals WHERE mint='M1'`;
    expect(Number(rows[0]!.current_mc)).toBe(120000);
    expect(Number(rows[0]!.ath_mc)).toBe(120000);
    expect(Number(rows[0]!.ath_multiplier)).toBeCloseTo(2.4, 5);
    expect(rows[0]!.is_hit).toBe(true);
  });

  test("sets safe_call_mc once the signal is older than 3 minutes", async () => {
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at)
      VALUES ('M2',2,'["W1","W2"]'::jsonb,'independent',10000,
              now() - interval '10 minutes', now() - interval '10 minutes')`;
    await refreshSignals(t.db, {
      source: fixedSource({ M2: 11000 }),
      hitMultiplier: 2,
      closeAfterHours: 48,
    });
    const rows = await t.sql`SELECT safe_call_mc, safe_promoted_at FROM signals WHERE mint='M2'`;
    expect(rows[0]!.safe_call_mc).not.toBeNull();
    expect(Number(rows[0]!.safe_call_mc)).toBe(11000);
    expect(rows[0]!.safe_promoted_at).not.toBeNull();
  });

  test("closes signals past the TTL and skips co_funded/closed rows", async () => {
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at, status)
      VALUES
        ('M3',2,'["W1"]'::jsonb,'independent',1000, now() - interval '50 hours', now() - interval '50 hours','open'),
        ('M4',2,'["W1"]'::jsonb,'co_funded',1000, now(), now(),'closed')`;
    const stats = await refreshSignals(t.db, {
      source: fixedSource({ M3: 5000 }),
      hitMultiplier: 2,
      closeAfterHours: 48,
    });
    const m3 = await t.sql`SELECT status FROM signals WHERE mint='M3'`;
    expect(m3[0]!.status).toBe("closed");
    expect(stats.closed).toBe(1);
    expect(stats.selected).toBe(1); // M4 (closed) never selected
  });

  test("preserves last-known current_mc when the price source omits the mint", async () => {
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at)
      VALUES ('MKEEP',2,'["W1","W2"]'::jsonb,'independent',1000, now(), now())`;
    // First tick: source has a quote -> current_mc set.
    await refreshSignals(t.db, {
      source: fixedSource({ MKEEP: 5000 }),
      hitMultiplier: 2,
      closeAfterHours: 48,
    });
    // Second tick: source omits MKEEP entirely -> current_mc must NOT be nulled.
    await refreshSignals(t.db, { source: fixedSource({}), hitMultiplier: 2, closeAfterHours: 48 });
    const rows = await t.sql`SELECT current_mc, ath_mc FROM signals WHERE mint='MKEEP'`;
    expect(Number(rows[0]!.current_mc)).toBe(5000); // preserved, not nulled
    expect(Number(rows[0]!.ath_mc)).toBe(5000); // ath also intact
  });

  test("closing a hit signal credits its wallets' signal_winrate", async () => {
    await t.sql`INSERT INTO tracked_wallets (address, label) VALUES ('W1','one'),('W2','two')`;
    // One past CLOSED hit + one about-to-close hit, both naming W1/W2.
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, ath_mc, is_hit, first_buy_at, detected_at, status)
      VALUES ('PAST',2,'["W1","W2"]'::jsonb,'independent',1000,3000,true,
              now() - interval '60 hours', now() - interval '60 hours','closed')`;
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at, status)
      VALUES ('NOW',2,'["W1","W2"]'::jsonb,'independent',1000,
              now() - interval '50 hours', now() - interval '50 hours','open')`;

    await refreshSignals(t.db, {
      source: fixedSource({ NOW: 4000 }),
      hitMultiplier: 2,
      closeAfterHours: 48,
    });

    const w =
      await t.sql`SELECT signal_signals, signal_wins, signal_winrate FROM tracked_wallets WHERE address='W1'`;
    expect(Number(w[0]!.signal_signals)).toBe(2); // PAST + NOW, both closed independent
    expect(Number(w[0]!.signal_wins)).toBe(2); // both hit
    expect(Number(w[0]!.signal_winrate)).toBeCloseTo(1.0, 4);
  });

  test("a price-source failure does not throw out of the tick", async () => {
    await t.sql`
      INSERT INTO signals (mint, wallet_count, wallets, trust, call_mc, first_buy_at, detected_at)
      VALUES ('MERR',2,'["W1"]'::jsonb,'independent',1000, now(), now())`;
    const throwingSource: PriceSource = {
      name: "boom",
      async fetch() {
        throw new Error("upstream down");
      },
    };
    const stats = await refreshSignals(t.db, {
      source: throwingSource,
      hitMultiplier: 2,
      closeAfterHours: 48,
    });
    // Resilience (spec §9): the tick reports the failure and touches nothing
    // rather than throwing — graphile-worker keeps firing on the next cron.
    expect(stats.errored).toBe(1);
    expect(stats.updated).toBe(0);
    const rows = await t.sql`SELECT status, current_mc FROM signals WHERE mint='MERR'`;
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.current_mc).toBeNull();
  });
});
