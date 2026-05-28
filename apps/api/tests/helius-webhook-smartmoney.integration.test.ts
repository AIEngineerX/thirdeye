import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authTokens, smartTrades, trackedWallets, watchEvents, watches } from "@thirdeye/db";
import { app } from "../src/index";
import { type IntelEvent, subscribe } from "../src/lib/intel-bus";
import { generateToken } from "../src/lib/tokens";
import { type TestDb, setupTestDb, waitFor } from "./setup";

// Fixture wallet — matches feePayer + tokenTransfer.toUserAccount in the buy fixture.
const FIXTURE_WALLET = "WaLLeT1111111111111111111111111111111111111";
const FIXTURE_MINT = "MiNT2222222222222222222222222222222222222222";
const FIXTURE_SIG = "5xBuySig11111111111111111111111111111111111111111111111111111111";

// Import the fixture as a plain object so the test is self-contained.
// Path is relative to the monorepo root; Bun resolves imports from the
// test file's directory, so use a relative path from apps/api/tests/.
import buyFixture from "../../../packages/scanner/tests/fixtures/helius-swap-buy.json";

const ORIGINAL_ENV = { ...process.env };

let testDb: TestDb;
let token: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.HELIUS_WEBHOOK_AUTH = "smartmoney-test-secret";
});

afterAll(async () => {
  process.env.HELIUS_WEBHOOK_AUTH = ORIGINAL_ENV.HELIUS_WEBHOOK_AUTH;
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.sql.unsafe(
    "TRUNCATE auth_tokens, smart_trades, tracked_wallets, wallet_checks, wallets, token_scans, funders, intel_aggregates, watches, watch_events, helius_webhooks, signals RESTART IDENTITY CASCADE;",
  );
  const t = generateToken();
  await testDb.db.insert(authTokens).values({ token: t.token, expiresAt: t.expiresAt });
  token = t.token;
});

const AUTH = { "Content-Type": "application/json", Authorization: "smartmoney-test-secret" };

describe("smart-money webhook ingest", () => {
  test("tracked-only wallet (NOT in watches): smart_trades row inserted + smartmoney:trade event published", async () => {
    // Key assertion for the resolveWatched gap: insert ONLY into tracked_wallets,
    // not watches. The event should still be processed.
    await testDb.db.insert(trackedWallets).values({
      address: FIXTURE_WALLET,
      label: "TestAlpha",
      winRate: "0.72",
    });

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([buyFixture]),
    });

    expect(r.status).toBe(200);
    // persisted counts watch:event rows — 0 because wallet is not in watches
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.received).toBe(1);
    expect(body.persisted).toBe(0);

    // Wait for the async publish to arrive
    await waitFor(() => seen.filter((e) => e.event === "smartmoney:trade").length === 1);

    const tradeEvts = seen.filter((e) => e.event === "smartmoney:trade");
    expect(tradeEvts).toHaveLength(1);
    const d = tradeEvts[0]!.data as {
      wallet: string;
      mint: string;
      side: string;
      signature: string;
      label: string | null;
    };
    expect(d.wallet).toBe(FIXTURE_WALLET);
    expect(d.mint).toBe(FIXTURE_MINT);
    expect(d.side).toBe("buy");
    expect(d.signature).toBe(FIXTURE_SIG);
    expect(d.label).toBe("TestAlpha");

    // DB row
    const rows = await testDb.db.select().from(smartTrades);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wallet).toBe(FIXTURE_WALLET);
    expect(rows[0]!.mint).toBe(FIXTURE_MINT);
    expect(rows[0]!.side).toBe("buy");
    expect(rows[0]!.signature).toBe(FIXTURE_SIG);

    // No watch_events row (not in watches)
    const weRows = await testDb.db.select().from(watchEvents);
    expect(weRows).toHaveLength(0);

    unsub();
  });

  test("wallet in BOTH tracked_wallets and watches: both watch:event AND smartmoney:trade are published", async () => {
    await testDb.db.insert(watches).values({ address: FIXTURE_WALLET, label: "watch", token });
    await testDb.db.insert(trackedWallets).values({
      address: FIXTURE_WALLET,
      label: "SmartAlpha",
      winRate: "0.65",
    });

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([buyFixture]),
    });

    expect(r.status).toBe(200);
    const body = (await r.json()) as { received: number; persisted: number };
    expect(body.persisted).toBe(1); // watch:event was persisted

    await waitFor(
      () =>
        seen.filter((e) => e.event === "watch:event").length === 1 &&
        seen.filter((e) => e.event === "smartmoney:trade").length === 1,
    );

    expect(seen.filter((e) => e.event === "watch:event")).toHaveLength(1);
    expect(seen.filter((e) => e.event === "smartmoney:trade")).toHaveLength(1);

    // One watch_events row
    const weRows = await testDb.db.select().from(watchEvents);
    expect(weRows).toHaveLength(1);

    // One smart_trades row
    const stRows = await testDb.db.select().from(smartTrades);
    expect(stRows).toHaveLength(1);

    unsub();
  });

  test("duplicate event for tracked wallet: second POST inserts nothing (dedup on signature+wallet)", async () => {
    await testDb.db.insert(trackedWallets).values({
      address: FIXTURE_WALLET,
      label: null,
      winRate: null,
    });

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    // First POST
    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([buyFixture]),
    });
    await waitFor(() => seen.filter((e) => e.event === "smartmoney:trade").length === 1);

    // Second POST — same event
    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([buyFixture]),
    });

    // Give publish a moment to deliver any spurious second event
    await new Promise((r) => setTimeout(r, 100));

    // Only one trade row despite two calls
    const rows = await testDb.db.select().from(smartTrades);
    expect(rows).toHaveLength(1);

    unsub();
  });

  test("confluence fires when >=2 distinct tracked wallets buy the same mint in the window", async () => {
    const WALLET_A = FIXTURE_WALLET;
    const WALLET_B = "WaLLeT2222222222222222222222222222222222222";

    await testDb.db.insert(trackedWallets).values([
      { address: WALLET_A, label: "Alpha A", winRate: "0.70" },
      { address: WALLET_B, label: "Alpha B", winRate: "0.68" },
    ]);

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    // Use a recent timestamp so both trades fall within the 30-min confluence window.
    // The fixture's original timestamp (1779667200) is ~24 days in the past.
    const nowSec = Math.floor(Date.now() / 1000);
    const evtA = { ...buyFixture, timestamp: nowSec };

    // Build a second event for WALLET_B buying the same mint
    const evtB = {
      ...buyFixture,
      signature: "5xBuySig22222222222222222222222222222222222222222222222222222222",
      timestamp: nowSec,
      feePayer: WALLET_B,
      nativeTransfers: [
        {
          fromUserAccount: WALLET_B,
          toUserAccount: "PooL9999999999999999999999999999999999999999",
          amount: 1500000000,
        },
      ],
      tokenTransfers: [
        {
          fromUserAccount: "PooL9999999999999999999999999999999999999999",
          toUserAccount: WALLET_B,
          mint: FIXTURE_MINT,
          tokenAmount: 1000000,
        },
      ],
      accountData: [{ account: WALLET_B, nativeBalanceChange: -1500005000 }],
    };

    // POST wallet A's buy first
    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([evtA]),
    });
    await waitFor(() => seen.filter((e) => e.event === "smartmoney:trade").length === 1);

    // POST wallet B's buy — should trigger confluence
    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([evtB]),
    });

    await waitFor(
      () =>
        seen.filter((e) => e.event === "smartmoney:trade").length === 2 &&
        seen.filter((e) => e.event === "smartmoney:confluence").length === 1,
    );

    const confEvts = seen.filter((e) => e.event === "smartmoney:confluence");
    expect(confEvts).toHaveLength(1);
    const cd = confEvts[0]!.data as { mint: string; count: number; wallets: string[] };
    expect(cd.mint).toBe(FIXTURE_MINT);
    expect(cd.count).toBe(2);
    expect(cd.wallets.sort()).toEqual([WALLET_A, WALLET_B].sort());

    unsub();
  });

  test("two independent tracked buys promote one open signal + emit smartmoney:signal", async () => {
    const WALLET_A = FIXTURE_WALLET;
    const WALLET_B = "WaLLeT2222222222222222222222222222222222222";

    // Independent: insert into tracked_wallets only, NOT into `wallets` — so
    // areCoFunded finds no shared first_funder and the confluence is independent.
    await testDb.db.insert(trackedWallets).values([
      { address: WALLET_A, label: "Alpha A", winRate: "0.70" },
      { address: WALLET_B, label: "Alpha B", winRate: "0.68" },
    ]);

    const seen: IntelEvent[] = [];
    const unsub = subscribe((e) => seen.push(e));

    const nowSec = Math.floor(Date.now() / 1000);
    const evtA = { ...buyFixture, timestamp: nowSec };
    const evtB = {
      ...buyFixture,
      signature: "5xBuySig22222222222222222222222222222222222222222222222222222222",
      timestamp: nowSec,
      feePayer: WALLET_B,
      nativeTransfers: [
        {
          fromUserAccount: WALLET_B,
          toUserAccount: "PooL9999999999999999999999999999999999999999",
          amount: 1500000000,
        },
      ],
      tokenTransfers: [
        {
          fromUserAccount: "PooL9999999999999999999999999999999999999999",
          toUserAccount: WALLET_B,
          mint: FIXTURE_MINT,
          tokenAmount: 1000000,
        },
      ],
      accountData: [{ account: WALLET_B, nativeBalanceChange: -1500005000 }],
    };

    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([evtA]),
    });
    await waitFor(() => seen.filter((e) => e.event === "smartmoney:trade").length === 1);

    await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([evtB]),
    });

    await waitFor(() => seen.filter((e) => e.event === "smartmoney:signal").length === 1);

    const sigEvts = seen.filter((e) => e.event === "smartmoney:signal");
    expect(sigEvts).toHaveLength(1);
    const sd = sigEvts[0]!.data as { mint: string; trust: string; walletCount: number };
    expect(sd.mint).toBe(FIXTURE_MINT);
    expect(sd.trust).toBe("independent");
    expect(sd.walletCount).toBe(2);

    const rows =
      await testDb.sql`SELECT trust, status, wallet_count FROM signals WHERE mint = ${FIXTURE_MINT}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.trust).toBe("independent");
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.wallet_count).toBe(2);

    unsub();
  });

  test("non-swap event for tracked wallet: no smart_trades row (parseWalletTrade returns null)", async () => {
    await testDb.db.insert(trackedWallets).values({ address: FIXTURE_WALLET, label: null });

    const r = await app.request("/api/helius-webhook", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify([
        {
          signature: "non-swap-sig-111",
          type: "TRANSFER",
          source: "SYSTEM_PROGRAM",
          feePayer: FIXTURE_WALLET,
          timestamp: 1779667200,
          tokenTransfers: [], // no token transfers — parseWalletTrade returns null
          accountData: [{ account: FIXTURE_WALLET, nativeBalanceChange: -5000 }],
        },
      ]),
    });

    expect(r.status).toBe(200);
    const rows = await testDb.db.select().from(smartTrades);
    expect(rows).toHaveLength(0);
  });
});
